import { createHash } from "node:crypto";
import { etagOf, HttpError, jsonLogger, parseDuration, safeLog, type Logger, type Repository } from "../public.ts";

/** What a throttle store keeps per key: the failures, until when the key is locked, and when the entry expires. */
export interface LoginThrottleRecord {
  failures: number;
  /** Epoch milliseconds until which the key is locked, when it is. */
  lockedUntil?: number;
  /** Epoch milliseconds after which the entry is forgotten. */
  expiresAt: number;
  /** An opaque version a store may return from `get` to make the next `set` of the key conditional. */
  version?: string;
}

/** Thrown by a store's `set` when the entry changed since `get` returned it; the guard reads it again and retries. */
export class ThrottleConflictError extends Error {
  constructor(key: string) {
    super(`Throttle entry ${key} changed concurrently`);
    this.name = "ThrottleConflictError";
  }
}

/** Where `loginGuard` keeps its counters: per worker in memory, or shared through a repository. */
export interface LoginThrottleStore {
  get(key: string): LoginThrottleRecord | undefined | Promise<LoginThrottleRecord | undefined>;
  /** Stores the entry for `ttlMs`; may throw `ThrottleConflictError` when the entry changed since `get`. */
  set(key: string, value: LoginThrottleRecord, ttlMs: number): void | Promise<void>;
  delete(key: string): void | Promise<void>;
}

/** A store that keeps the counters in this worker's memory, dropping expired entries as they are read. */
export function memoryThrottleStore(now: () => number = Date.now): LoginThrottleStore & { keys(): string[] } {
  const entries = new Map<string, { value: LoginThrottleRecord; until: number }>();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.until <= now()) {
        entries.delete(key);
        return undefined;
      }
      return { ...entry.value };
    },
    set(key, value, ttlMs) {
      entries.set(key, { value: { ...value }, until: now() + ttlMs });
    },
    delete(key) {
      entries.delete(key);
    },
    keys: () => [...entries.keys()],
  };
}

/**
 * A store over a repository whose entity has `key` (unique), `failures`, `lockedUntil` and `expiresAt`: every write is
 * conditional on the version read, so concurrent failures across replicas are all counted.
 */
export function repositoryThrottleStore(repository: Repository): LoginThrottleStore {
  const find = (key: string) => repository.findOne([{ field: "key", op: "eq", value: key }]);
  const isConflict = (error: unknown) => (error instanceof HttpError && (error.status === 412 || error.status === 409)) || (error as Error)?.name === "UniqueViolationError";
  return {
    async get(key) {
      const record = await find(key);
      if (!record) return undefined;
      const expiresAt = new Date(record.expiresAt as string | Date).getTime();
      const lockedUntil = record.lockedUntil ? new Date(record.lockedUntil as string | Date).getTime() : undefined;
      // An expired entry reads as none, but its version keeps the next write conditional on it.
      const version = `${record.id} ${etagOf(record)}`;
      if (expiresAt <= Date.now()) return { failures: 0, expiresAt: 0, version };
      return { failures: Number(record.failures), ...(lockedUntil !== undefined ? { lockedUntil } : {}), expiresAt, version };
    },
    async set(key, value) {
      const data = { failures: value.failures, lockedUntil: value.lockedUntil !== undefined ? new Date(value.lockedUntil) : null, expiresAt: new Date(value.expiresAt) };
      try {
        if (value.version === undefined) {
          await repository.create({ key, ...data });
          return;
        }
        const at = value.version.indexOf(" ");
        await repository.update(value.version.slice(0, at), data, { ifMatch: value.version.slice(at + 1) });
      } catch (error) {
        if (isConflict(error)) throw new ThrottleConflictError(key);
        throw error;
      }
    },
    async delete(key) {
      const record = await find(key);
      if (record) await repository.delete(record.id);
    },
  };
}

/** A sign-in identifier as the guard keys it: trimmed, NFKC-normalized, lowercased and hashed with SHA-256. */
export function identifierHash(identifier: string): string {
  return createHash("sha256").update(identifier.trim().normalize("NFKC").toLowerCase()).digest("hex");
}

/** What `loginGuard` takes; durations are texts like `15m`. */
export interface LoginGuardOptions {
  store?: LoginThrottleStore;
  /** Failures per identifier before it is locked (default 5). */
  maxAttempts?: number;
  /** How long failures count after the last one (default `15m`). */
  window?: string;
  /** The first lockout, doubled by each further failure (default `1m`). */
  lockout?: string;
  /** The longest lockout (default `1h`). */
  maxLockout?: string;
  /** Failures per client address within the window, across identifiers, before the address is refused (default 50). */
  ipMaxAttempts?: number;
  /** The clock, in epoch milliseconds (default `Date.now`). */
  now?: () => number;
  /** Where `auth.lockout` is logged (default: the JSON logger). */
  logger?: Logger;
}

/** The answer of a check. */
export type LoginCheck = { allowed: true } | { allowed: false; retryAfterMs: number };

/** The progressive lockout of sign-in attempts per identifier and per client address. */
export interface LoginGuard {
  check(attempt: { identifier: string; ip: string }): Promise<LoginCheck>;
  /** Counts a failure for the identifier and the address, whether or not the account exists. */
  fail(attempt: { identifier: string; ip: string }): Promise<void>;
  /** Clears the identifier's failures after a successful sign-in (not the address's). */
  succeed(attempt: { identifier: string }): Promise<void>;
  /** Checks the attempt and throws the 429 `Too many attempts; try again later` for a refused one, logging `auth.lockout`. */
  assert(attempt: { identifier: string; ip: string }): Promise<void>;
}

/** The 429 a provider answers to a refused sign-in, the same for existing and unknown accounts. */
export function tooManyAttempts(retryAfterMs: number): HttpError {
  return new HttpError(429, "Too many attempts; try again later", { headers: { "retry-after": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) } });
}

const duration = (text: string | undefined, fallback: number) => (text === undefined ? fallback : (parseDuration(text) ?? fallback));

/**
 * Progressive lockout against password guessing: 5 failures of an identifier within `15m` lock it for `1m`, each
 * further failure doubles the lockout up to `1h`, and 50 failures from one address within the window refuse that
 * address; identifiers are stored only as SHA-256 hashes.
 */
export function loginGuard(options: LoginGuardOptions = {}): LoginGuard {
  const now = options.now ?? Date.now;
  const store = options.store ?? memoryThrottleStore(now);
  const maxAttempts = options.maxAttempts ?? 5;
  const windowMs = duration(options.window, 15 * 60_000);
  const lockoutMs = duration(options.lockout, 60_000);
  const maxLockoutMs = duration(options.maxLockout, 3_600_000);
  const ipMaxAttempts = options.ipMaxAttempts ?? 50;
  const logger = options.logger ?? jsonLogger;
  const idKey = (identifier: string) => `id:${identifierHash(identifier)}`;
  const ipKey = (ip: string) => `ip:${ip}`;
  const live = (record: LoginThrottleRecord | undefined, at: number) => (record && record.expiresAt > at ? record : undefined);

  /** Reads, changes and writes one entry, again from the read when another writer won. */
  const change = async (key: string, next: (current: LoginThrottleRecord | undefined, at: number) => LoginThrottleRecord) => {
    for (let attempt = 0; ; attempt++) {
      const read = await store.get(key);
      const at = now();
      const current = live(read, at);
      const value = next(current, at);
      try {
        await store.set(key, { ...value, ...(read?.version !== undefined ? { version: read.version } : {}) }, Math.max(1, value.expiresAt - at));
        return;
      } catch (error) {
        if (!(error instanceof ThrottleConflictError) || attempt >= 50) throw error;
      }
    }
  };

  const check: LoginGuard["check"] = async ({ identifier, ip }) => {
    const at = now();
    const id = live(await store.get(idKey(identifier)), at);
    if (id?.lockedUntil !== undefined && id.lockedUntil > at) return { allowed: false, retryAfterMs: id.lockedUntil - at };
    const address = live(await store.get(ipKey(ip)), at);
    if (address && address.failures >= ipMaxAttempts) return { allowed: false, retryAfterMs: address.expiresAt - at };
    return { allowed: true };
  };

  return {
    check,
    async fail({ identifier, ip }) {
      await change(idKey(identifier), (current, at) => {
        const failures = (current?.failures ?? 0) + 1;
        if (failures < maxAttempts) return { failures, expiresAt: at + windowMs };
        const lock = Math.min(lockoutMs * 2 ** (failures - maxAttempts), maxLockoutMs);
        return { failures, lockedUntil: at + lock, expiresAt: at + lock + windowMs };
      });
      // The address's window is fixed from its first failure.
      await change(ipKey(ip), (current, at) => ({ failures: (current?.failures ?? 0) + 1, expiresAt: current?.expiresAt ?? at + windowMs }));
    },
    async succeed({ identifier }) {
      await store.delete(idKey(identifier));
    },
    async assert(attempt) {
      const result = await check(attempt);
      if (result.allowed) return;
      safeLog(logger, "warn", { timestamp: new Date().toISOString(), message: "auth.lockout", identifier: identifierHash(attempt.identifier).slice(0, 8), ip: attempt.ip });
      throw tooManyAttempts(result.retryAfterMs);
    },
  };
}

/** The 401 `INVALID_CREDENTIALS` providers answer to every sign-in failure: unknown account, wrong password, disabled account. */
export function invalidCredentials(): HttpError {
  return new HttpError(401, "Invalid credentials", { code: "INVALID_CREDENTIALS" });
}

let dummyHash: Promise<string> | undefined;

/**
 * Verifies the password against a fixed hash of the default cost and resolves false, so a sign-in for an unknown
 * account takes as long as one with a wrong password.
 */
export async function dummyPasswordCheck(password: string): Promise<false> {
  dummyHash ??= Bun.password.hash("quickservicets dummy password");
  await Bun.password.verify(password, await dummyHash);
  return false;
}
