import { afterCommit, currentTransaction, safeLog, schemaIdentifier, type DatabaseAdapter, type EntityModel, type FieldModel, type Logger, type StoredRecord } from "../public.ts";
import { directoryClock } from "./directory.ts";

/** The staging table of each core model whose rows a tenant database stages inside its transactions. */
export const STAGED_TABLES: Readonly<Record<string, string>> = {
  OutboxEvent: "qs_staged_outbox_events",
  OutboxDelivery: "qs_staged_outbox_deliveries",
  QueueMessage: "qs_staged_queue_messages",
};

/** What the `tenancy/relay` job runs: the relay of every database tenant, set by the running native. */
export const relayState: { all?: () => Promise<void> } = {};

/** Staged rows younger than this are left to the relay of their own transaction. */
export const RELAY_MIN_AGE_MS = 5000;

const staged = new WeakMap<EntityModel, EntityModel>();

/** The staging model of a core model: its fields, without unique constraints or indexes, in its staging table. */
export function stagedModel(model: EntityModel): EntityModel {
  let found = staged.get(model);
  if (!found) {
    const table = STAGED_TABLES[model.key]!;
    found = {
      ...model,
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
      tenancy: "tenant",
    };
    staged.set(model, found);
  }
  return found;
}

/** The staging models of the core models in a model list, in relay order. */
export function stagingModels(models: readonly EntityModel[]): EntityModel[] {
  return Object.keys(STAGED_TABLES).flatMap((key) => {
    const model = models.find((candidate) => candidate.key === key && candidate.system);
    return model ? [stagedModel(model)] : [];
  });
}

const columnOf = (name: string) => name.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);

/** The statement that creates a staging table, if it does not exist, with the columns of its model. */
export function stagingTableStatement(model: EntityModel, dialect: "sqlite" | "postgres"): string {
  const type = (field: FieldModel) => {
    if (field.storage === "json") return dialect === "sqlite" ? "text" : "jsonb";
    if (field.type === "number") return dialect === "sqlite" ? "real" : "double precision";
    if (field.type === "boolean") return dialect === "sqlite" ? "integer" : "boolean";
    if (field.type === "date") return dialect === "sqlite" ? "integer" : "timestamp with time zone";
    return "text";
  };
  const date = dialect === "sqlite" ? "integer" : "timestamp with time zone";
  const columns = [`"id" text PRIMARY KEY NOT NULL`, `"created_at" ${date} NOT NULL`, `"updated_at" ${date} NOT NULL`];
  for (const field of model.fields) {
    if (field.storage === "relation" || field.storage === "derived" || field.storage === "computed") continue;
    columns.push(`"${columnOf(field.name)}" ${type(field)}`);
  }
  return `CREATE TABLE IF NOT EXISTS "${schemaIdentifier(model.tableName)}" (${columns.join(", ")})`;
}

export interface RelayOptions {
  /** The service's own database, holding the shared tables. */
  root: DatabaseAdapter;
  /** The core models of the shared tables, by key. */
  models: ReadonlyMap<string, EntityModel>;
  logger: Logger;
}

const condition = (field: string, op: "eq" | "lte", value: unknown) => ({ field, op, value }) as never;

/**
 * Moves the staged rows of a tenant database to the shared tables, in id order, keeping their ids: a row already
 * there is not copied again, and a staged queue message whose dedupe key a live message holds is dropped. Failures keep
 * the rows and are logged as `tenancy.relay.failed`; each relay that moved rows logs `tenancy.relay.moved` (debug).
 */
export function tenantRelay(options: RelayOptions) {
  const { root, logger } = options;
  const relay = async (tenant: string, adapter: DatabaseAdapter, minAgeMs = 0): Promise<Record<string, number> | undefined> => {
    const counts: Record<string, number> = {};
    try {
      for (const [key, model] of options.models) {
        const stagedTable = stagedModel(model);
        const before = new Date(directoryClock.now() - minAgeMs);
        for (;;) {
          const { data } = await adapter.findMany(stagedTable, { where: minAgeMs > 0 ? [condition("createdAt", "lte", before)] : [], sort: [{ field: "id", direction: "asc" }], limit: 500, offset: 0, withTotal: false });
          for (const row of data) {
            await moveRow(root, model, row);
            await adapter.deleteById(stagedTable, row.id);
            counts[key] = (counts[key] ?? 0) + 1;
          }
          if (data.length < 500) break;
        }
      }
    } catch (error) {
      safeLog(logger, "error", { timestamp: new Date(directoryClock.now()).toISOString(), message: "tenancy.relay.failed", tenant, error: { message: (error as Error)?.message ?? String(error) } });
      return undefined;
    }
    if (Object.keys(counts).length > 0) safeLog(logger, "debug", { timestamp: new Date(directoryClock.now()).toISOString(), message: "tenancy.relay.moved", tenant, counts });
    return counts;
  };
  /** The transactions that already relay their staged rows after they commit. */
  const scheduled = new WeakSet<object>();
  return {
    relay,
    /** Relays the tenant's staged rows once the current transaction commits (once per transaction). */
    afterCommit(tenant: string, adapter: DatabaseAdapter) {
      const transaction = currentTransaction();
      if (!transaction || scheduled.has(transaction)) return;
      scheduled.add(transaction);
      void afterCommit(() => relay(tenant, adapter));
    },
  };
}

export type TenantRelay = ReturnType<typeof tenantRelay>;

/** Copies one staged row to its shared table unless it is there already, applying the queue's dedupe keys. */
async function moveRow(root: DatabaseAdapter, model: EntityModel, row: StoredRecord): Promise<void> {
  if (await root.findById(model, row.id)) return;
  if (model.key === "QueueMessage" && typeof row.dedupeSlot === "string") {
    const holder = await root.findOne(model, [condition("dedupeSlot", "eq", row.dedupeSlot)]);
    // A live or completed holder keeps deduplicating its key (a completed one until its slot is released).
    if (holder && (holder.status === "waiting" || holder.status === "active" || holder.status === "completed")) return;
    // A dead holder frees its slot, so the staged message takes the key.
    if (holder) await root.updateById(model, holder.id, { dedupeSlot: null, updatedAt: new Date(directoryClock.now()) });
  }
  await root.insert(model, row);
}
