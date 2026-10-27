import { UniqueViolationError, safeLog, scopedAdapter, type Condition, type DatabaseAdapter, type EntityModel, type FieldModel, type Logger, type StoredRecord } from "../public.ts";

/** A response kept for replays: its status, a few headers and its text body. */
export interface StoredResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** One idempotency key, as the store keeps it. */
export interface IdempotencyRecord {
  id: string;
  /** The key with the method, route and user, hashed: unique. */
  scope: string;
  /** A hash of the method, path, sorted query and body of the first request. */
  fingerprint: string;
  status: "running" | "done";
  response?: StoredResponse | null;
  expiresAt: Date;
  lockedUntil?: Date | null;
}

/** How long a running record keeps other requests of its scope away before another one may take it over. */
export const LOCK_MS = 60_000;

/** Records deleted per batch by the cleanup. */
export const CLEANUP_BATCH = 1000;

/** What `begin` found: a new record to run, a stored response to replay, or a conflict. */
export type BeginResult =
  | { kind: "new"; record: IdempotencyRecord }
  | { kind: "replay"; record: IdempotencyRecord }
  | { kind: "reused"; record: IdempotencyRecord }
  | { kind: "inUse"; record: IdempotencyRecord };

/** The system entity of idempotency keys. */
export function idempotencyKeyEntity(): EntityModel {
  const fields: FieldModel[] = [
    { name: "scope", type: "string", optional: false, unique: true, storage: "column" },
    { name: "fingerprint", type: "string", optional: false, storage: "column" },
    { name: "status", type: "enum", values: ["running", "done"], optional: false, storage: "column" },
    { name: "response", type: "json", optional: true, storage: "json" },
    { name: "expiresAt", type: "date", optional: false, storage: "column" },
    { name: "lockedUntil", type: "date", optional: true, storage: "column" },
  ] as FieldModel[];
  const include = ["id", "createdAt", "updatedAt", ...fields.map((field) => field.name)];
  return {
    key: "IdempotencyKey",
    entityName: "IdempotencyKey",
    schema: null,
    name: "idempotency-keys",
    repoKey: "idempotencyKeys",
    tableName: "idempotency_keys",
    fields,
    hooks: [],
    overrideHooks: "inherit",
    internal: true,
    exposure: { list: { include, exclude: [] }, read: { include, exclude: [] } },
    indexes: [{ fields: ["expiresAt"] }],
    system: true,
  };
}

const condition = (field: string, op: "eq" | "lt" | "lte" | "gt", value: unknown): Condition => ({ field, op, value }) as Condition;

/** The idempotency keys in the project's database. */
export function databaseStore(rootAdapter: DatabaseAdapter, model: EntityModel, logger: Logger, now: () => number = Date.now) {
  // Keys live in the database of the current scope, so a tenant's keys stay in its own database.
  const db = () => scopedAdapter(rootAdapter);
  const insertOrSkip = async (row: StoredRecord): Promise<StoredRecord | null> => {
    const adapter = db();
    if (adapter.insertOrSkip) return adapter.insertOrSkip(model, row, "scope");
    try {
      return await adapter.insert(model, row);
    } catch (error) {
      if (error instanceof UniqueViolationError) return null;
      throw error;
    }
  };
  return {
    /**
     * Starts a request of a scope: inserts a running record through the unique scope, or tells why the request must
     * not run (a replay, a different request, one in progress). An expired record is deleted first, and a running one
     * whose lock passed is taken over.
     */
    async begin(input: { scope: string; fingerprint: string; ttlMs: number }): Promise<BeginResult> {
      for (let round = 0; round < 5; round++) {
        const at = now();
        const record: StoredRecord = {
          id: Bun.randomUUIDv7(),
          createdAt: new Date(at),
          updatedAt: new Date(at),
          scope: input.scope,
          fingerprint: input.fingerprint,
          status: "running",
          expiresAt: new Date(at + input.ttlMs),
          lockedUntil: new Date(at + LOCK_MS),
        };
        const inserted = await insertOrSkip(record);
        if (inserted) return { kind: "new", record: inserted as unknown as IdempotencyRecord };
        const existing = (await db().findOne(model, [condition("scope", "eq", input.scope)])) as unknown as IdempotencyRecord | null;
        if (!existing) continue;
        // An expired record is never replayed, even before the cleanup removes it.
        if (new Date(existing.expiresAt).getTime() <= at) {
          await db().deleteById(model, existing.id);
          continue;
        }
        if (existing.fingerprint !== input.fingerprint) return { kind: "reused", record: existing };
        if (existing.status === "done") return { kind: "replay", record: existing };
        if (existing.lockedUntil && new Date(existing.lockedUntil).getTime() > at) return { kind: "inUse", record: existing };
        // The process that ran it stopped: take it over, unless another request did first.
        const taken = await db().updateById(model, existing.id, { lockedUntil: new Date(at + LOCK_MS), expiresAt: new Date(at + input.ttlMs), updatedAt: new Date(at) }, [
          condition("status", "eq", "running"),
          condition("lockedUntil", "eq", existing.lockedUntil),
        ]);
        return taken ? { kind: "new", record: taken as unknown as IdempotencyRecord } : { kind: "inUse", record: existing };
      }
      throw new Error("The idempotency key could not be stored; try again");
    },
    /** Stores the response of a running record, kept until `ttlMs` from now. */
    async complete(record: IdempotencyRecord, response: StoredResponse, ttlMs: number): Promise<IdempotencyRecord | null> {
      const at = now();
      const done = await db().updateById(
        model,
        record.id,
        { status: "done", response: response as unknown as StoredRecord[string], expiresAt: new Date(at + ttlMs), lockedUntil: null, updatedAt: new Date(at) },
        [condition("status", "eq", "running")],
      );
      return done as unknown as IdempotencyRecord | null;
    },
    /** Deletes a record, so a retry of its scope runs again. */
    async release(record: IdempotencyRecord): Promise<void> {
      await db().deleteById(model, record.id);
    },
    /** Deletes the expired records in batches; each deletion counts once across instances. */
    async cleanup(): Promise<number> {
      let deleted = 0;
      let after: string | undefined;
      for (;;) {
        const { data } = await db().findMany(model, {
          where: [condition("expiresAt", "lt", new Date(now())), ...(after ? [condition("id", "gt", after)] : [])],
          sort: [{ field: "id", direction: "asc" }],
          limit: CLEANUP_BATCH,
          offset: 0,
          withTotal: false,
        });
        for (const row of data) if (await db().deleteById(model, row.id)) deleted++;
        if (data.length < CLEANUP_BATCH) break;
        after = data.at(-1)!.id;
      }
      safeLog(logger, "info", { timestamp: new Date(now()).toISOString(), message: "idempotency.cleanup", count: deleted });
      return deleted;
    },
  };
}

export type DatabaseIdempotencyStore = ReturnType<typeof databaseStore>;
