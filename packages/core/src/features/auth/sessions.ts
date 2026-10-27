import { createHash, randomBytes } from "node:crypto";
import { parseDuration, type EntityRecord, type Repository } from "../public.ts";
import type { RevokeTarget } from "./api.ts";

/** A stored session: the provider's entity with the fields the store manages. */
export interface StoredSession extends EntityRecord {
  /** The SHA-256 of the session's token, hex; the token itself is never stored. */
  tokenHash: string;
  userId: string;
  expiresAt: Date;
  idleExpiresAt?: Date | null;
  lastUsedAt: Date;
}

/** What `sessionStore` takes. */
export interface SessionStoreOptions {
  /** The repository of the provider's session entity, or a function returning it once the service runs. */
  entity: Repository | (() => Repository);
  /** The text every token starts with, like `qs_sess_`. */
  tokenPrefix: string;
  /** How long a session lives, like `30d`. */
  expiresIn: string;
  /** How long a session lives without being used, like `2h`; extended at most once per hour. */
  idle?: string;
  /** The most sessions one user keeps; creating one more deletes the oldest. */
  maxPerUser?: number;
  /** How long each worker trusts a validated session without reading it again (default `30s`). */
  cacheTtl?: string;
  /** The most sessions each worker caches (default 10000). */
  cacheSize?: number;
  /** The clock, in epoch milliseconds (default `Date.now`). */
  now?: () => number;
}

/** Opaque server-side sessions in a provider's entity, with a per-worker cache, revocation and pruning. */
export interface SessionStore<S extends StoredSession = StoredSession> {
  /** Creates a session for the user with the provider's own fields, resolving its token (shown once) and the record. */
  create(userId: string, data?: Record<string, unknown>): Promise<{ token: string; session: S }>;
  /** The session of a token, or null for an unknown, expired or idle-expired one. */
  validate(token: string): Promise<S | null>;
  /** Deletes the session of a token. */
  delete(token: string): Promise<void>;
  /** Deletes one session, or every session of a user, and drops them from this worker's cache. */
  revoke(target: RevokeTarget): Promise<number>;
  /** Deletes the sessions expired for more than one day, in batches of 1000; resolves how many. */
  prune(): Promise<number>;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;
const BATCH = 1000;

/** The SHA-256 of a token, hex. */
export const tokenHashOf = (token: string) => createHash("sha256").update(token).digest("hex");

const time = (value: unknown) => (value instanceof Date ? value.getTime() : value === null || value === undefined ? undefined : new Date(value as string).getTime());

/**
 * A shared store of opaque sessions for providers that keep their own: tokens are `tokenPrefix` and 32 random bytes in
 * base64url, only their SHA-256 is stored, and each worker caches validated sessions for `cacheTtl`.
 */
export function sessionStore<S extends StoredSession = StoredSession>(options: SessionStoreOptions): SessionStore<S> {
  const repository = () => (typeof options.entity === "function" ? options.entity() : options.entity);
  const now = options.now ?? Date.now;
  const expiresMs = parseDuration(options.expiresIn);
  if (expiresMs === undefined) throw new Error(`sessionStore: invalid expiresIn ${options.expiresIn}`);
  const idleMs = options.idle === undefined ? undefined : parseDuration(options.idle);
  if (options.idle !== undefined && idleMs === undefined) throw new Error(`sessionStore: invalid idle ${options.idle}`);
  const cacheTtl = parseDuration(options.cacheTtl ?? "30s") ?? 30_000;
  const cacheSize = options.cacheSize ?? 10_000;
  /** Validated sessions by token hash, least recently used first. */
  const cache = new Map<string, { session: S; cachedAt: number }>();
  const remember = (hash: string, session: S, at: number) => {
    cache.delete(hash);
    cache.set(hash, { session, cachedAt: at });
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value!);
  };
  const expired = (session: S, at: number) => (time(session.expiresAt) ?? 0) <= at || (idleMs !== undefined && (time(session.idleExpiresAt) ?? Infinity) <= at);
  const byField = (field: string, value: unknown) => [{ field, op: "eq" as const, value }];

  return {
    async create(userId, data = {}) {
      const token = `${options.tokenPrefix}${randomBytes(32).toString("base64url")}`;
      const at = now();
      const session = (await repository().create({
        ...data,
        tokenHash: tokenHashOf(token),
        userId,
        expiresAt: new Date(at + expiresMs),
        ...(idleMs !== undefined ? { idleExpiresAt: new Date(at + idleMs) } : {}),
        lastUsedAt: new Date(at),
      })) as S;
      if (options.maxPerUser !== undefined) {
        const page = await repository().list({ where: byField("userId", userId), sort: [{ field: "createdAt", direction: "desc" }, { field: "id", direction: "desc" }], limit: 1000, offset: 0 });
        for (const old of page.data.slice(options.maxPerUser)) if (old.id !== session.id) await repository().delete(old.id);
      }
      return { token, session };
    },
    async validate(token) {
      if (typeof token !== "string" || !token.startsWith(options.tokenPrefix)) return null;
      const hash = tokenHashOf(token);
      const at = now();
      const cached = cache.get(hash);
      if (cached && at - cached.cachedAt < cacheTtl) {
        if (!expired(cached.session, at)) return cached.session;
        cache.delete(hash);
        return null;
      }
      const session = (await repository().findOne(byField("tokenHash", hash))) as S | null;
      if (!session || expired(session, at)) {
        cache.delete(hash);
        return null;
      }
      let current = session;
      // The idle expiry moves forward with use, written at most once per hour.
      if (at - (time(session.lastUsedAt) ?? 0) >= HOUR) {
        current = (await repository().update(session.id, { lastUsedAt: new Date(at), ...(idleMs !== undefined ? { idleExpiresAt: new Date(at + idleMs) } : {}) })) as S;
      }
      remember(hash, current, at);
      return current;
    },
    async delete(token) {
      const hash = tokenHashOf(token);
      cache.delete(hash);
      const session = await repository().findOne(byField("tokenHash", hash));
      if (session) await repository().delete(session.id);
    },
    async revoke(target) {
      const matches = (session: S) => ("sessionId" in target ? session.id === target.sessionId : session.userId === target.userId);
      for (const [hash, entry] of cache) if (matches(entry.session)) cache.delete(hash);
      if ("sessionId" in target) {
        const session = await repository().findById(target.sessionId);
        if (!session) return 0;
        await repository().delete(session.id);
        return 1;
      }
      let count = 0;
      for (;;) {
        const page = await repository().list({ where: byField("userId", target.userId), sort: [], limit: BATCH, offset: 0 });
        for (const session of page.data) await repository().delete(session.id);
        count += page.data.length;
        if (page.data.length < BATCH) return count;
      }
    },
    async prune() {
      const cutoff = new Date(now() - DAY);
      let count = 0;
      for (;;) {
        const page = await repository().list({ where: [{ field: "expiresAt", op: "lt", value: cutoff }], sort: [], limit: BATCH, offset: 0 });
        for (const session of page.data) await repository().delete(session.id);
        count += page.data.length;
        if (page.data.length < BATCH) return count;
      }
    },
  };
}
