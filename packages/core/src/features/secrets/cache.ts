import { parseDuration, safeLog, storeSecretValue, type Logger, type ReferenceLocation, type SecretReference } from "../public.ts";
import { reasonOf, resolveReference, type NoRetry, type ProviderRegistry, type ResolvedSecret, type ResolveSettings } from "./resolve.ts";

/** The clock the secrets cache reads; tests replace it. */
let clock: () => number = () => Date.now();

/** Replaces the clock of the secrets cache (undefined restores the real one); for tests with a fake clock. */
export function setSecretsClock(now: (() => number) | undefined): void {
  clock = now ?? (() => Date.now());
}

/** The cache's current time. */
export const secretsNow = (): number => clock();

/** What `onRotate` hooks and the `secret.rotated` event receive: where the secret is used, the reference and the new version, never the value. */
export interface SecretRotation {
  path: string;
  reference: string;
  version?: string;
}

/** One reference the cache keeps fresh. */
export interface CacheEntry {
  reference: SecretReference;
  value?: string;
  version?: string;
  dueAt: number;
  expiresAt?: number;
  /** Where the value is used in the configuration; empty for references only read with `secrets.get`. */
  locations: ReferenceLocation[];
  /** The resolution running now, so a reference is resolved once at a time. */
  running?: Promise<string>;
  /** Whether the last refresh failed. */
  failing: boolean;
  /** When `secrets.refresh.failed` was logged last. */
  failureLoggedAt?: number;
  expiredLogged: boolean;
  /** When code last read it (for the per-tenant cache, which refreshes only entries in use). */
  usedAt: number;
  /** When the value was resolved last. */
  resolvedAt: number;
  /** Whether code read the value since it was resolved last. */
  readSinceResolved?: boolean;
  /** The last failed resolution of a reference without a value, refused again until `failureCooldown` passed. */
  failed?: { at: number; error: unknown };
}

/** When a value resolved at `now` is due again: at its ttl, or at two thirds of the time until it expires, whichever comes first. */
export function dueTime(now: number, defaultTtl: number, result: Pick<ResolvedSecret, "ttl" | "expiresAt">): number {
  const candidates: number[] = [];
  if (result.ttl !== undefined) {
    const ttl = typeof result.ttl === "number" ? result.ttl : parseDuration(result.ttl);
    if (ttl !== undefined && ttl >= 0) candidates.push(now + ttl);
  }
  if (result.expiresAt !== undefined) {
    const expires = new Date(result.expiresAt).getTime();
    if (Number.isFinite(expires)) candidates.push(now + Math.max(0, expires - now) * (2 / 3));
  }
  if (candidates.length === 0) candidates.push(now + defaultTtl);
  return Math.min(...candidates);
}

/** How the cache resolves and what it tells when values change or refreshes fail. */
export interface CacheSettings {
  registry: ProviderRegistry;
  resolve: ResolveSettings;
  noRetry?: NoRetry;
  /** The `ttl` option, in milliseconds. */
  ttl: number;
  logger: Logger;
  /** Called after a value changed, once per location (or once with no path for references read with `get`). */
  rotated(entry: CacheEntry, previous: string | undefined): void | Promise<void>;
  /** Called after a refresh pass with the entries whose value changed, so related values (a certificate and its key) apply together. */
  afterPass?(changed: CacheEntry[]): void | Promise<void>;
  /** The most entries kept; the least recently used is evicted (default: no limit). */
  maxEntries?: number;
  /**
   * Refreshes only entries read since they were resolved, and resolves a due entry again when it is read, so idle
   * references cost no provider calls (the per-tenant cache).
   */
  onlyUsed?: boolean;
  /** How long a failed first resolution is refused without calling the provider again, in milliseconds (default 0). */
  failureCooldown?: number;
  /** Called when a first resolution failed, before the error reaches the reader. */
  failed?(reference: SecretReference, error: unknown): void;
}

const MINUTE = 60_000;

/** The resolved references of one service, refreshed when due. */
export class SecretCache {
  readonly entries = new Map<string, CacheEntry>();
  private pass: Promise<void> | undefined;

  constructor(private readonly settings: CacheSettings) {}

  /** Keeps a value resolved at startup, with where it is used. */
  add(reference: SecretReference, resolved: ResolvedSecret, locations: ReferenceLocation[]): CacheEntry {
    const now = clock();
    const entry: CacheEntry = {
      reference,
      value: resolved.value,
      ...(resolved.version !== undefined ? { version: resolved.version } : {}),
      dueAt: dueTime(now, this.settings.ttl, resolved),
      ...(resolved.expiresAt !== undefined ? { expiresAt: new Date(resolved.expiresAt).getTime() } : {}),
      locations,
      failing: false,
      expiredLogged: false,
      usedAt: now,
      resolvedAt: now,
    };
    this.entries.set(reference.text, entry);
    return entry;
  }

  /** The current value of a reference, resolving it once (one resolution in flight) when it is new. */
  async get(reference: SecretReference): Promise<string> {
    const now = clock();
    const entry = this.entries.get(reference.text);
    if (entry) {
      entry.usedAt = now;
      // The map's order is the order of use, so the first entry is the least recently used.
      if (this.settings.maxEntries !== undefined) {
        this.entries.delete(reference.text);
        this.entries.set(reference.text, entry);
      }
      if (entry.running) return entry.running;
      if (entry.value !== undefined && !(this.settings.onlyUsed && entry.dueAt <= now)) {
        entry.readSinceResolved = true;
        return entry.value;
      }
      if (entry.value === undefined && entry.failed && now - entry.failed.at < (this.settings.failureCooldown ?? 0)) throw entry.failed.error;
    }
    const created: CacheEntry = entry ?? { reference, dueAt: 0, locations: [], failing: false, expiredLogged: false, usedAt: now, resolvedAt: 0 };
    if (!entry) {
      this.entries.set(reference.text, created);
      this.evict();
    }
    const running = resolveReference(this.settings.registry, reference, this.settings.resolve, this.settings.noRetry).then((resolved) => {
      this.apply(created, resolved);
      return resolved.value;
    });
    created.running = running;
    try {
      return await running;
    } catch (error) {
      if (created.value === undefined) {
        // A reference that never resolved is refused for the cooldown, then tried again on the next read.
        if ((this.settings.failureCooldown ?? 0) > 0) created.failed = { at: clock(), error };
        else this.entries.delete(reference.text);
        this.settings.failed?.(reference, error);
        throw error;
      }
      // A due value whose refresh failed keeps serving the last value.
      created.failing = true;
      return created.value;
    } finally {
      created.running = undefined;
    }
  }

  /** Drops the least recently used entries above `maxEntries`. */
  private evict(): void {
    const max = this.settings.maxEntries;
    if (max === undefined) return;
    for (const [text] of this.entries) {
      if (this.entries.size <= max) break;
      this.entries.delete(text);
    }
  }

  /** Stores a new resolution: the value behind `secretValue`, the next due time and the expiry. */
  private apply(entry: CacheEntry, resolved: ResolvedSecret): void {
    const now = clock();
    entry.value = resolved.value;
    if (resolved.version !== undefined) entry.version = resolved.version;
    else delete entry.version;
    entry.dueAt = dueTime(now, this.settings.ttl, resolved);
    if (resolved.expiresAt !== undefined) entry.expiresAt = new Date(resolved.expiresAt).getTime();
    else delete entry.expiresAt;
    entry.failing = false;
    entry.expiredLogged = false;
    entry.resolvedAt = now;
    entry.readSinceResolved = false;
    delete entry.failed;
    storeSecretValue(entry.reference.text, { value: resolved.value, ...(resolved.version !== undefined ? { version: resolved.version } : {}) });
  }

  /** The paths a log entry names for an entry: where it is used, or its reference text for one read with `get`. */
  static paths(entry: CacheEntry): string[] {
    return entry.locations.length > 0 ? [...new Set(entry.locations.map((location) => location.path))] : [entry.reference.text];
  }

  /** Re-resolves the entries that are due, in the background of the caller (never a request); one pass at a time. */
  refreshDue(filter: (entry: CacheEntry) => boolean = () => true): Promise<void> {
    this.pass ??= this.refreshOnce(filter).finally(() => (this.pass = undefined));
    return this.pass;
  }

  private async refreshOnce(filter: (entry: CacheEntry) => boolean): Promise<void> {
    const now = clock();
    const due = [...this.entries.values()].filter(
      (entry) => entry.value !== undefined && !entry.running && entry.dueAt <= now && filter(entry) && (!this.settings.onlyUsed || entry.readSinceResolved === true),
    );
    const changed = (await Promise.all(due.map((entry) => this.refresh(entry)))).filter((entry): entry is CacheEntry => entry !== undefined);
    if (changed.length > 0) await this.settings.afterPass?.(changed);
    for (const entry of this.entries.values()) {
      if (entry.expiresAt === undefined || entry.expiresAt > clock() || !entry.failing || entry.expiredLogged) continue;
      entry.expiredLogged = true;
      for (const path of SecretCache.paths(entry)) safeLog(this.settings.logger, "error", { timestamp: new Date(clock()).toISOString(), message: "secrets.expired", path, reference: entry.reference.text });
    }
  }

  /** Refreshes one entry; resolves it when its value changed. */
  private async refresh(entry: CacheEntry): Promise<CacheEntry | undefined> {
    const previous = entry.value;
    const work = resolveReference(this.settings.registry, entry.reference, this.settings.resolve, this.settings.noRetry);
    entry.running = work.then((resolved) => resolved.value);
    entry.running.catch(() => {});
    try {
      const resolved = await work;
      this.apply(entry, resolved);
      if (resolved.value !== previous) {
        await this.settings.rotated(entry, previous);
        return entry;
      }
    } catch (error) {
      entry.failing = true;
      const now = clock();
      if (entry.failureLoggedAt === undefined || now - entry.failureLoggedAt >= MINUTE) {
        entry.failureLoggedAt = now;
        const reason = reasonOf(entry.reference, error);
        for (const path of SecretCache.paths(entry)) safeLog(this.settings.logger, "warn", { timestamp: new Date(now).toISOString(), message: "secrets.refresh.failed", path, reason });
      }
    } finally {
      entry.running = undefined;
    }
    return undefined;
  }

  /** The paths of the values that failed their last refresh or expired, for the health check. */
  failingPaths(): string[] {
    const now = clock();
    return [...this.entries.values()].filter((entry) => entry.failing || (entry.expiresAt !== undefined && entry.expiresAt <= now)).flatMap((entry) => SecretCache.paths(entry));
  }
}
