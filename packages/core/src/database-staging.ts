import type { DatabaseAdapter, StoredRecord } from "./adapter.ts";
import type { EntityModel, FieldModel } from "./model.ts";
import { jsonLogger, safeLog, type Logger } from "./logger.ts";
import { connectedModels, databaseOf, isDatabaseRouter, outsideTransaction, transactionDatabase, type DatabaseRouter } from "./named-databases.ts";
import { afterCommit, currentTransaction } from "./transactions.ts";

/** The staging table of each core model whose rows a transaction of another database stages. */
export const STAGED_TABLES: Readonly<Record<string, string>> = {
  OutboxEvent: "qs_staged_outbox_events",
  OutboxDelivery: "qs_staged_outbox_deliveries",
  QueueMessage: "qs_staged_queue_messages",
};

/** Staged rows younger than this are left to the relay of their own transaction. */
export const RELAY_MIN_AGE_MS = 5000;

const condition = (field: string, op: "eq" | "lte", value: unknown) => ({ field, op, value }) as never;

/** Copies one staged row to its shared table unless it is there already, applying the queue's dedupe keys. */
export async function moveStagedRow(root: DatabaseAdapter, model: EntityModel, row: StoredRecord, now: () => number = Date.now): Promise<void> {
  if (await root.findById(model, row.id)) return;
  if (model.key === "QueueMessage" && typeof row.dedupeSlot === "string") {
    const holder = await root.findOne(model, [condition("dedupeSlot", "eq", row.dedupeSlot)]);
    // A live or completed holder keeps deduplicating its key (a completed one until its slot is released).
    if (holder && (holder.status === "waiting" || holder.status === "active" || holder.status === "completed")) return;
    // A dead holder frees its slot, so the staged message takes the key.
    if (holder) await root.updateById(model, holder.id, { dedupeSlot: null, updatedAt: new Date(now()) });
  }
  await root.insert(model, row);
}

const staged = new WeakMap<EntityModel, Map<string, EntityModel>>();

/** The staging model of a core model in the database `name`: its fields, without unique constraints or indexes. */
export function databaseStagedModel(model: EntityModel, name: string): EntityModel {
  let byDatabase = staged.get(model);
  if (!byDatabase) {
    byDatabase = new Map();
    staged.set(model, byDatabase);
  }
  let found = byDatabase.get(name);
  if (!found) {
    const table = STAGED_TABLES[model.key]!;
    const { tenancy: _tenancy, ...rest } = model;
    found = {
      ...rest,
      key: `Staged${model.key}`,
      entityName: `Staged${model.key}`,
      schema: null,
      name: table.replaceAll("_", "-"),
      repoKey: table,
      tableName: table,
      fields: model.fields.map((field) => ({ ...field, unique: false })) as FieldModel[],
      indexes: [],
      internal: true,
      system: true,
      database: name,
    };
    byDatabase.set(name, found);
  }
  return found;
}

/** The core models with a staging table among `models`, in relay order. */
function stagedCoreModels(models: readonly EntityModel[]): EntityModel[] {
  return Object.keys(STAGED_TABLES).flatMap((key) => {
    const model = models.find((candidate) => candidate.key === key && candidate.system);
    return model ? [model] : [];
  });
}

/** The relays of each router, scheduled once per transaction. */
const scheduled = new WeakSet<object>();
let relayLogger: Logger = jsonLogger;

/** Sets where relay failures are logged; `createApp` calls it. */
export function configureDatabaseRelay(logger: Logger): void {
  relayLogger = logger;
}

/**
 * Where a core row (a queue message, an outbox event or delivery) goes when it is written inside a transaction of a
 * named database while its table lives in another one: the staging table of the transaction's database, relayed to
 * the shared table once the transaction commits. Undefined when the row goes to its own table.
 */
export function stagedSystemTarget(adapter: DatabaseAdapter, model: EntityModel): { adapter: DatabaseAdapter; model: EntityModel } | undefined {
  if (!isDatabaseRouter(adapter) || !model.system || model.perDatabase || !(model.key in STAGED_TABLES)) return undefined;
  const database = transactionDatabase(adapter);
  if (database === undefined || database === databaseOf(model)) return undefined;
  const transaction = currentTransaction();
  if (transaction && !scheduled.has(transaction)) {
    scheduled.add(transaction);
    void afterCommit(() => relayDatabase(adapter, database));
  }
  return { adapter, model: databaseStagedModel(model, database) };
}

/**
 * Moves the staged rows of database `name` to the shared tables, in id order, keeping their ids (a row already there
 * is not copied again), and only rows older than `minAgeMs`. Failures keep the rows and are logged as
 * `database.relay.failed`; resolves the rows moved per core model, or undefined after a failure.
 */
export async function relayDatabase(router: DatabaseRouter, name: string, minAgeMs = 0): Promise<Record<string, number> | undefined> {
  const counts: Record<string, number> = {};
  try {
    await outsideTransaction(async () => {
      for (const model of stagedCoreModels(connectedModels(router))) {
        if (databaseOf(model) === name) continue;
        const stagedTable = databaseStagedModel(model, name);
        const before = new Date(Date.now() - minAgeMs);
        for (;;) {
          const { data } = await router.findMany(stagedTable, { where: minAgeMs > 0 ? [condition("createdAt", "lte", before)] : [], sort: [{ field: "id", direction: "asc" }], limit: 500, offset: 0, withTotal: false });
          for (const row of data) {
            await moveStagedRow(router, model, row);
            await router.deleteById(stagedTable, row.id);
            counts[model.key] = (counts[model.key] ?? 0) + 1;
          }
          if (data.length < 500) break;
        }
      }
    });
  } catch (error) {
    safeLog(relayLogger, "error", { timestamp: new Date().toISOString(), message: "database.relay.failed", database: name, error: { message: (error as Error)?.message ?? String(error) } });
    return undefined;
  }
  return counts;
}

/** Relays the staged rows of every named database, older than `minAgeMs`: what a relay interrupted before left. */
export async function relayAllDatabases(router: DatabaseRouter, minAgeMs = RELAY_MIN_AGE_MS): Promise<void> {
  if (stagedCoreModels(connectedModels(router)).length === 0) return;
  for (const name of Object.keys(router.databases)) await relayDatabase(router, name, minAgeMs);
}

/** How often the staged rows a relay left behind are moved. */
export const RELAY_SWEEP_MS = 30_000;

/** Relays what interrupted relays left, at once and every `RELAY_SWEEP_MS`, while started. */
export function databaseRelaySweeper(adapter: DatabaseAdapter) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  const sweep = () => {
    if (!isDatabaseRouter(adapter) || running) return;
    running = relayAllDatabases(adapter).finally(() => {
      running = undefined;
    });
  };
  return {
    start() {
      if (!isDatabaseRouter(adapter) || timer) return;
      sweep();
      timer = setInterval(sweep, RELAY_SWEEP_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    async idle() {
      await running;
    },
  };
}
