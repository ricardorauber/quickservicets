/** What a rate limit store decides for one hit. */
export interface RateLimitResult {
  /** Whether the request may proceed; only allowed hits are counted. */
  allowed: boolean;
  /** The limit of the bucket. */
  limit: number;
  /** Requests left in the bucket after this hit, at least 0. */
  remaining: number;
  /** Milliseconds until the current window ends. */
  resetMs: number;
  /** Milliseconds until a refused request could be allowed (0 when allowed). */
  retryAfterMs: number;
}

/** What a hit asks for: the bucket's limit and window, and the time of the hit. */
export interface RateLimitHit {
  limit: number;
  windowMs: number;
  now: number;
}

/**
 * Where rate limit counters live. `hit` counts one request against a bucket with the sliding window counter of the
 * current and previous fixed windows, and decides it; a store shared by several workers or replicas resolves a promise.
 */
export interface RateLimitStore {
  hit(key: string, hit: RateLimitHit): RateLimitResult | Promise<RateLimitResult>;
  /** Forgets a bucket. */
  reset(key: string): void | Promise<void>;
}

/** The counts of one bucket: the current and previous fixed windows, and its place in the recency list. */
export interface WindowCounts {
  windowStart: number;
  current: number;
  previous: number;
}

/**
 * Decides a hit on a bucket's counts, updating them: the window rolls over when `now` is past the current one, the
 * estimate is `previous × (1 − elapsed ÷ window) + current`, and a request is allowed (and counted) when the estimate
 * plus one does not exceed the limit.
 */
export function slidingWindowHit(counts: WindowCounts, { limit, windowMs, now }: RateLimitHit): RateLimitResult {
  const start = now - (now % windowMs);
  if (start !== counts.windowStart) {
    counts.previous = start - counts.windowStart === windowMs ? counts.current : 0;
    counts.current = 0;
    counts.windowStart = start;
  }
  const elapsed = now - start;
  const weight = 1 - elapsed / windowMs;
  const estimate = counts.previous * weight + counts.current;
  const allowed = estimate + 1 <= limit;
  if (allowed) counts.current++;
  const resetMs = windowMs - elapsed;
  let retryAfterMs = 0;
  if (!allowed) {
    // Within this window the previous window's share shrinks; past it, only this window's count remains.
    const room = limit - 1 - counts.current;
    retryAfterMs = counts.previous > 0 && room >= 0 ? Math.max(1, Math.ceil(windowMs * (1 - room / counts.previous) - elapsed)) : resetMs;
  }
  return { allowed, limit, remaining: Math.max(0, Math.floor(limit - estimate - (allowed ? 1 : 0))), resetMs, retryAfterMs };
}

interface Entry extends WindowCounts {
  key: string;
  windowMs: number;
  lastUsed: number;
  newer: Entry | undefined;
  older: Entry | undefined;
}

/** How many idle buckets one hit removes at most, so expiry never makes one request slow. */
const EXPIRED_PER_HIT = 8;

/** The memory store: one process's counters, with at most `maxKeys` buckets. */
export interface MemoryRateLimitStore extends RateLimitStore {
  hit(key: string, hit: RateLimitHit): RateLimitResult;
  /** How many buckets it holds. */
  size(): number;
}

/**
 * Counters kept in this process: a hit is one map lookup and a few integer updates, without promises. Buckets idle for
 * two of their windows are dropped, and the least recently used bucket is evicted when `maxKeys` is reached.
 */
export function memoryRateLimitStore({ maxKeys = 100_000 }: { maxKeys?: number } = {}): MemoryRateLimitStore {
  const entries = new Map<string, Entry>();
  // The recency list: `newest` was hit last, `oldest` first.
  let newest: Entry | undefined;
  let oldest: Entry | undefined;
  const unlink = (entry: Entry) => {
    if (entry.newer) entry.newer.older = entry.older;
    else newest = entry.older;
    if (entry.older) entry.older.newer = entry.newer;
    else oldest = entry.newer;
    entry.newer = entry.older = undefined;
  };
  const pushNewest = (entry: Entry) => {
    entry.older = newest;
    entry.newer = undefined;
    if (newest) newest.newer = entry;
    newest = entry;
    oldest ??= entry;
  };
  const remove = (entry: Entry) => {
    unlink(entry);
    entries.delete(entry.key);
  };
  return {
    hit(key, hit) {
      for (let count = 0; count < EXPIRED_PER_HIT && oldest && hit.now - oldest.lastUsed >= 2 * oldest.windowMs; count++) remove(oldest);
      let entry = entries.get(key);
      if (entry === undefined) {
        if (entries.size >= maxKeys && oldest) remove(oldest);
        entry = { key, windowMs: hit.windowMs, windowStart: hit.now - (hit.now % hit.windowMs), current: 0, previous: 0, lastUsed: hit.now, newer: undefined, older: undefined };
        entries.set(key, entry);
        pushNewest(entry);
      } else if (entry !== newest) {
        unlink(entry);
        pushNewest(entry);
      }
      entry.lastUsed = hit.now;
      entry.windowMs = hit.windowMs;
      return slidingWindowHit(entry, hit);
    },
    reset(key) {
      const entry = entries.get(key);
      if (entry) remove(entry);
    },
    size: () => entries.size,
  };
}
