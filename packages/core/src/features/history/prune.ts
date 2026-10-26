import { parseDuration, safeLog, type Condition, type DatabaseAdapter, type EntityModel, type Logger, type StoredRecord } from "../public.ts";
import type { HistoryRetentionFunction, HistoryStore } from "./api.ts";
import type { DatabaseHistoryStore } from "./store.ts";

/** The most versions one pruning batch reads and deletes. */
export const PRUNE_BATCH = 1000;

/** How a pruning of one entity runs. */
export interface PruneOptions {
  /** Versions whose `at` is before it may be deleted. */
  before: Date;
  /** Keeps the highest version of each record whose last operation is not `delete` (default true). */
  keepLatest?: boolean;
  /** More conditions the deleted versions match, like a tenant. */
  where?: Condition[];
  /** Stops between batches once aborted. */
  signal?: AbortSignal;
  /** Counts what would be deleted without deleting it. */
  dryRun?: boolean;
  /** Called after each batch, with the number of versions it read. */
  onBatch?: (size: number) => void;
}

/**
 * Deletes the versions older than `before` from a history table, in batches of at most 1000, except the current
 * version of each live record. Safe on several instances at once: a version counts only for the call that deleted it.
 */
export async function pruneVersions(adapter: DatabaseAdapter, model: EntityModel, options: PruneOptions): Promise<number> {
  const keepLatest = options.keepLatest ?? true;
  const latest = new Map<string, StoredRecord | null>();
  const latestOf = async (entityId: string) => {
    if (!latest.has(entityId)) {
      const { data } = await adapter.findMany(model, {
        where: [{ field: "entityId", op: "eq", value: entityId }],
        sort: [{ field: "version", direction: "desc" }],
        limit: 1,
        offset: 0,
        withTotal: false,
      });
      latest.set(entityId, data[0] ?? null);
    }
    return latest.get(entityId) ?? null;
  };
  let cursor: string | undefined;
  let deleted = 0;
  for (;;) {
    if (options.signal?.aborted) return deleted;
    const { data } = await adapter.findMany(model, {
      where: [{ field: "at", op: "lt", value: options.before }, ...(options.where ?? []), ...(cursor ? [{ field: "id", op: "gt" as const, value: cursor }] : [])],
      sort: [{ field: "id", direction: "asc" }],
      limit: PRUNE_BATCH,
      offset: 0,
      withTotal: false,
    });
    for (const row of data) {
      cursor = row.id;
      if (keepLatest) {
        const current = await latestOf(row.entityId as string);
        if (current && current.id === row.id && current.operation !== "delete") continue;
      }
      if (options.dryRun) deleted++;
      else if (await adapter.deleteById(model, row.id)) deleted++;
    }
    options.onBatch?.(data.length);
    if (data.length < PRUNE_BATCH) return deleted;
  }
}

/** One entity whose history may be pruned, with its retention. */
export interface PruneTarget {
  entity: EntityModel;
  /** The retention, like `365d`, or a function of the tenant; undefined keeps its versions forever. */
  retention: string | HistoryRetentionFunction | undefined;
}

/** What `pruneHistory` takes. */
export interface PruneRun {
  store: HistoryStore;
  /** The history tables, when they are the store: they prune per tenant, in batches, and count dry runs. */
  database?: { adapter: DatabaseAdapter; store: DatabaseHistoryStore };
  targets: readonly PruneTarget[];
  logger?: Logger;
  signal?: AbortSignal;
  dryRun?: boolean;
  /** The current time in milliseconds (default `Date.now()`). */
  now?: number;
}

/** A retention in milliseconds, failing naming `history.retention` when it is not a duration. */
function retentionMs(value: unknown): number {
  const ms = parseDuration(value);
  if (ms === undefined) throw new Error(`Invalid history.retention: expected a duration like 30s, 10m, 2h or 30d, got ${JSON.stringify(value)}`);
  return ms;
}

/** The retention of a function for one tenant, checked like the option. */
async function retentionFor(fn: HistoryRetentionFunction, entity: string, tenant: string | undefined): Promise<string | undefined> {
  // Called directly, as `undefined` (keep forever) is a valid answer the option's own check would refuse.
  const value = await fn({ entity, tenant, req: undefined, user: undefined } as never);
  if (value === undefined) return undefined;
  retentionMs(value);
  return value as string;
}

/** Prunes one entity: by tenant when its retention is a function and the store is the database. */
async function pruneEntity(run: PruneRun, target: PruneTarget, now: number): Promise<number> {
  const name = target.entity.entityName;
  const retention = target.retention!;
  const database = run.database;
  const pruneBefore = async (ms: number, where: Condition[] = []) => {
    const before = new Date(now - ms);
    if (!database) return run.dryRun ? 0 : run.store.prune(name, before, true);
    return pruneVersions(database.adapter, database.store.model(name), { before, where, ...(run.signal ? { signal: run.signal } : {}), ...(run.dryRun ? { dryRun: true } : {}) });
  };
  if (typeof retention !== "function") return pruneBefore(retentionMs(retention));
  if (!database) {
    const value = await retentionFor(retention, name, undefined);
    return value === undefined ? 0 : pruneBefore(retentionMs(value));
  }
  let deleted = 0;
  for (const tenant of await database.store.tenants(name)) {
    if (run.signal?.aborted) break;
    const value = await retentionFor(retention, name, tenant);
    if (value === undefined) continue;
    deleted += await pruneBefore(retentionMs(value), [tenant === undefined ? { field: "tenant", op: "isNull", value: true } : { field: "tenant", op: "eq", value: tenant }]);
  }
  return deleted;
}

/** Prunes every target that has a retention, logging `history.pruned` per entity; resolves the counts by entity name. */
export async function pruneHistory(run: PruneRun): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  const now = run.now ?? Date.now();
  for (const target of run.targets) {
    if (target.retention === undefined) continue;
    if (run.signal?.aborted) break;
    const started = performance.now();
    const deleted = await pruneEntity(run, target, now);
    result[target.entity.entityName] = deleted;
    if (run.logger && !run.dryRun) {
      safeLog(run.logger, "info", {
        timestamp: new Date().toISOString(),
        message: "history.pruned",
        entity: target.entity.entityName,
        deleted,
        durationMs: Math.round((performance.now() - started) * 1000) / 1000,
      });
    }
  }
  return result;
}

/** The pruning of the running service, set by the native's setup for the `history/prune` job. */
let running: Omit<PruneRun, "signal" | "dryRun" | "now"> | undefined;

/** Sets or clears the pruning the `history/prune` job runs. */
export function setRunningPrune(value: typeof running): void {
  running = value;
}

/** Runs the pruning of the running service; fails when the native's setup did not run in this process. */
export function pruneRunningService(signal?: AbortSignal): Promise<Record<string, number>> {
  if (!running) return Promise.reject(new Error("history is not running in this process; use quickservice history prune"));
  return pruneHistory({ ...running, ...(signal ? { signal } : {}) });
}
