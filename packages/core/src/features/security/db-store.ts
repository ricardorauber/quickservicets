import { createHash } from "node:crypto";
import { safeLog, type DatabaseAdapter, type EntityModel, type FieldModel, type Logger } from "../public.ts";
import { slidingWindowHit, type RateLimitHit, type RateLimitResult, type RateLimitStore, type WindowCounts } from "./store.ts";

/** The system entity holding shared rate limit counters: one record per bucket and fixed window. */
export function rateLimitCounterEntity(): EntityModel {
  const fields = [
    { name: "key", type: "string", optional: false, storage: "column" },
    { name: "windowStart", type: "date", optional: false, storage: "column" },
    { name: "count", type: "number", integer: true, optional: false, storage: "column" },
    { name: "expiresAt", type: "date", optional: false, storage: "column" },
  ] as FieldModel[];
  const include = ["id", "createdAt", "updatedAt", ...fields.map((field) => field.name)];
  return {
    key: "RateLimitCounter",
    entityName: "RateLimitCounter",
    schema: null,
    name: "rate-limit-counters",
    repoKey: "rateLimitCounters",
    tableName: "rate_limit_counters",
    fields,
    hooks: [],
    overrideHooks: "inherit",
    internal: true,
    exposure: { list: { include, exclude: [] }, read: { include, exclude: [] } },
    indexes: [{ fields: ["expiresAt"] }],
    system: true,
  };
}

/** The id of a bucket's counter for one window: a hash of the key and the window start. */
export function counterId(key: string, windowStart: number): string {
  return createHash("sha256").update(`${key}\n${windowStart}`).digest("hex").slice(0, 32);
}

/** One bucket as this worker sees it: the last synced totals plus its own hits not sent yet. */
interface Bucket extends WindowCounts {
  windowMs: number;
  /** The total of the current window at the last sync, every worker's hits included. */
  synced: number;
  /** This worker's hits on the current window not sent yet. */
  unsent: number;
}

/** Hits of a window that rolled over before they were sent. */
interface Leftover {
  key: string;
  windowStart: number;
  windowMs: number;
  count: number;
}

export interface DatabaseStoreOptions {
  adapter: DatabaseAdapter;
  model: EntityModel;
  logger: Logger;
  /** The time used for log throttling and cleanup (default `Date.now`). */
  now?: () => number;
}

/** The database store, with the sync, cleanup and flush the native runs on timers and at shutdown. */
export interface DatabaseRateLimitStore extends RateLimitStore {
  hit(key: string, hit: RateLimitHit): RateLimitResult;
  /** Sends the pending counts: one `increment` per bucket and window, storing the returned totals. */
  sync(): Promise<void>;
  /** Deletes the counters whose `expiresAt` has passed; safe to run in several workers at once. */
  cleanup(): Promise<number>;
}

const FAILURE_LOG_INTERVAL = 60_000;

/**
 * Rate limit counters shared through the project's database. Each hit is decided locally, without waiting for the
 * database, from the last synced totals plus this worker's own hits; `sync()` sends the pending counts and reads the
 * totals back, so the error is bounded by what other workers and replicas accept within one sync interval. A failing
 * sync keeps its counts for the next one and keeps deciding on local counts.
 */
export function databaseRateLimitStore({ adapter, model, logger, now = Date.now }: DatabaseStoreOptions): DatabaseRateLimitStore {
  const buckets = new Map<string, Bucket>();
  let leftovers: Leftover[] = [];
  let lastFailureLog = Number.NEGATIVE_INFINITY;
  let syncing: Promise<void> | undefined;

  const send = async (key: string, windowStart: number, windowMs: number, count: number): Promise<number> => {
    const at = new Date(now());
    const record = await adapter.increment!(model, counterId(key, windowStart), { count }, {
      id: counterId(key, windowStart),
      createdAt: at,
      updatedAt: at,
      key,
      windowStart: new Date(windowStart),
      count: 0,
      expiresAt: new Date(windowStart + 2 * windowMs),
    });
    return Number(record.count);
  };
  const failed = (error: unknown) => {
    const at = now();
    if (at - lastFailureLog < FAILURE_LOG_INTERVAL) return;
    lastFailureLog = at;
    safeLog(logger, "error", { timestamp: new Date(at).toISOString(), message: "security.rateLimit.store-failed", error: { message: (error as Error)?.message ?? String(error) } });
  };

  const runSync = async () => {
    // Windows that rolled over keep their last hits; they count in the previous window of other workers.
    const old = leftovers;
    leftovers = [];
    for (const leftover of old) {
      try {
        await send(leftover.key, leftover.windowStart, leftover.windowMs, leftover.count);
      } catch (error) {
        leftovers.push(leftover);
        failed(error);
      }
    }
    for (const [key, bucket] of buckets) {
      if (bucket.unsent === 0) continue;
      const { windowStart, windowMs } = bucket;
      const count = bucket.unsent;
      bucket.unsent = 0;
      try {
        const total = await send(key, windowStart, windowMs, count);
        if (bucket.windowStart === windowStart) {
          bucket.synced = total;
          bucket.current = total + bucket.unsent;
        } else if (bucket.windowStart === windowStart + windowMs) {
          bucket.previous = total;
        }
      } catch (error) {
        if (bucket.windowStart === windowStart) bucket.unsent += count;
        else leftovers.push({ key, windowStart, windowMs, count });
        failed(error);
      }
    }
  };

  return {
    hit(key, hit) {
      const start = hit.now - (hit.now % hit.windowMs);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { windowStart: start, windowMs: hit.windowMs, current: 0, previous: 0, synced: 0, unsent: 0 };
        buckets.set(key, bucket);
      } else if (bucket.windowStart !== start) {
        // The hits not sent yet still belong to the window that ended.
        if (bucket.unsent > 0) leftovers.push({ key, windowStart: bucket.windowStart, windowMs: bucket.windowMs, count: bucket.unsent });
        bucket.previous = start - bucket.windowStart === hit.windowMs ? bucket.current : 0;
        bucket.current = 0;
        bucket.synced = 0;
        bucket.unsent = 0;
        bucket.windowStart = start;
      }
      bucket.windowMs = hit.windowMs;
      const before = bucket.current;
      const result = slidingWindowHit(bucket, hit);
      if (bucket.current > before) bucket.unsent++;
      return result;
    },
    reset(key) {
      buckets.delete(key);
    },
    sync() {
      // One sync at a time; a call during a sync waits for it and runs again for what arrived meanwhile.
      const next = (syncing ?? Promise.resolve()).then(runSync);
      syncing = next.finally(() => {
        if (syncing === next) syncing = undefined;
      });
      return next;
    },
    async cleanup() {
      let removed = 0;
      for (;;) {
        const { data } = await adapter.findMany(model, { where: [{ field: "expiresAt", op: "lt", value: new Date(now()) }], sort: [{ field: "id", direction: "asc" }], limit: 500, offset: 0, withTotal: false });
        for (const record of data) if (await adapter.deleteById(model, record.id)) removed++;
        if (data.length < 500) return removed;
      }
    },
  };
}
