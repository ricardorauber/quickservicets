import { assertWritable, publicTransaction, runInTransaction } from "./transactions.ts";
import { tracingEnabled } from "./tracing.ts";
import { tracedAdapter } from "./traced-adapter.ts";
import { etagOf, ifMatch as ifMatchTag, preconditionFailed } from "./entity-tags.ts";
import { observersOf, reportChange } from "./write-observers.ts";
import {
  UniqueViolationError,
  type Aggregate,
  type AggregateValues,
  type DatabaseAdapter,
  type FindManyResult,
  type RelatedScope,
  type StoredRecord,
} from "./adapter.ts";
import { HttpError } from "./errors.ts";
import { conditionsOf, createQuery, type Query, type QueryBackend, type QueryLambda } from "./fluent-query.ts";
import { alwaysHiddenPaths, type EntityModel } from "./model.ts";
import { project } from "./projection.ts";
import { withFileUrls, type FileAccessSettings } from "./files/access.ts";
import { assertReferencedFilesAllowed } from "./files/field-limits.ts";
import {
  deleteObjects,
  isFileReferenced,
  objectOf,
  ownedFileFields,
  referencedIds,
  type FileCleanupSettings,
  type StoredObject,
} from "./files/cleanup.ts";
import { assertPopulatePaths, populateRecords } from "./populate.ts";
import {
  deriveRelations,
  derivedFields,
  releaseOneToOne,
  resolveDerivedConditions,
  withoutDerived,
  writeDerived,
  type Touch,
} from "./relations.ts";
import type { Condition, ListQuery } from "./query.ts";
import { assertReferencesExist, cascadedEntities, executeDeletePlan, planDelete } from "./referential-integrity.ts";
import { itemCount, ReferenceArrayChange, validateBody, type ValidationMode } from "./validation.ts";

export type EntityRecord = StoredRecord;

export interface ReadOptions {
  includeHidden?: boolean;
  /** Reference paths to replace with the referenced records, e.g. `organization` or `organization.logo`. */
  populate?: readonly string[];
  /** Top-level fields stored in the entity's own columns that are not read, such as vectors no one asked for. */
  omit?: readonly string[];
}

/** Options of `update`, `replace` and `delete`: the condition of an optimistic write. */
export interface WriteOptions extends ReadOptions {
  /**
   * An `If-Match` value: the write happens only when one listed tag equals the record's current entity tag (`etagOf`,
   * strong comparison) or the value is `*`, checked atomically with the write; otherwise it throws a 412 `HttpError`
   * with the current tag.
   */
  ifMatch?: string;
  /** Computes the entity tag `ifMatch` is compared with (default `etagOf`). */
  tagOf?: (record: StoredRecord) => string;
}

export interface RepositoryOptions {
  /** Maximum number of segments in a populate path (default 2). */
  populateMaxDepth?: number;
  /** Storages and access settings used to compute the `url` of file records. */
  fileAccess?: FileAccessSettings;
  /** When set, objects and file records that are no longer used are deleted. */
  fileCleanup?: FileCleanupSettings;
  /** Most records a fluent query's `toArray()` may return (default 10000). */
  toArrayMax?: number;
}

export const DEFAULT_TO_ARRAY_MAX = 10000;
const FIND_BY_IDS_BATCH = 100;

export interface ListResult<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

declare const reference: unique symbol;

/** In a references map: a reference to one `T` record, whose own references are `R` (lets populate paths go deeper). */
export interface One<T, R = Record<never, never>> {
  readonly [reference]: { kind: "one"; record: T; refs: R };
}

/**
 * In a references map: a reference array of `T` records, whose own references are `R`. `S` tells a stored array from
 * the derived side of a relation; only stored arrays can be followed with `related`.
 */
export interface Many<T, R = Record<never, never>, S extends "stored" | "derived" = "stored"> {
  readonly [reference]: { kind: "many"; record: T; refs: R; side: S };
}

type Head<P extends string> = P extends `${infer H}.${string}` ? H : P;
type Tail<P extends string, H extends string> = P extends `${H}.${infer Rest}` ? Rest : never;
type Expand<V, P extends string> = V extends { readonly [reference]: { kind: "one"; record: infer X; refs: infer XR } }
  ? Populated<X, XR, P> | null
  : V extends { readonly [reference]: { kind: "many"; record: infer X; refs: infer XR } }
    ? Array<Populated<X, XR, P>>
    : V;

/**
 * `T` with the populated paths `P` (e.g. `"profiles.permissions.module"`) replaced by the referenced records, at
 * every level. `R` maps reference fields to `One`/`Many` markers, or directly to the referenced record types.
 */
export type Populated<T, R, P extends string> = [P] extends [never]
  ? T
  : [Head<P> & keyof R] extends [never]
    ? T
    : Omit<T, Head<P> & keyof R> & { [H in Head<P> & keyof R]: Expand<R[H], Tail<P, H & string>> };

type RefsOf<V> = V extends { readonly [reference]: { refs: infer XR } } ? XR : never;
type PreviousDepth = [never, 0, 1, 2, 3, 4];

/** Every reference path of a references map, up to five segments. */
export type ReferencePath<R, D extends number = 5> = [D] extends [never]
  ? never
  : {
      [K in keyof R & string]: K | ([RefsOf<R[K]>] extends [never] ? never : `${K}.${ReferencePath<RefsOf<R[K]>, PreviousDepth[D]>}`);
    }[keyof R & string];

/** Paths a repository can populate: its reference paths, or any string when it has no typed references. */
export type PopulatePath<R> = [keyof R] extends [never] ? string : ReferencePath<R>;

/** Reference arrays `related` can follow: the stored `Many` fields of a references map, or any string without typed references. */
export type RelatedField<R> = [keyof R] extends [never]
  ? string
  : { [K in keyof R & string]: R[K] extends { readonly [reference]: { kind: "many"; side: "stored" } } ? K : never }[keyof R & string];

/** The record type a reference array of a references map lists. */
export type RelatedRecord<R, K> = K extends keyof R ? (R[K] extends { readonly [reference]: { record: infer X } } ? X : EntityRecord) : EntityRecord;

/** The references map of the records a reference array lists. */
export type RelatedReferences<R, K> = K extends keyof R
  ? R[K] extends { readonly [reference]: { refs: infer XR } }
    ? XR
    : Record<never, never>
  : Record<never, never>;

export type PopulateOptions<P extends readonly string[]> = Omit<ReadOptions, "populate"> & { populate?: P };

/**
 * Repository of one entity. `R` maps reference fields to the referenced record types, so populated reads are typed;
 * `C` and `U` type the bodies of `create`/`replace` and `update`.
 */
export interface Repository<T extends EntityRecord = EntityRecord, R = Record<never, never>, C = unknown, U = unknown> {
  /** Validates and stores a new record (defaults applied, references checked) and returns it. */
  create(data: C, options?: ReadOptions): Promise<T>;
  /** The record with this id, or null; `populate` replaces reference paths with records. */
  findById<const P extends readonly PopulatePath<R>[] = []>(id: string, options?: PopulateOptions<P>): Promise<Populated<T, R, P[number]> | null>;
  /** The first record matching every condition, or null. */
  findOne<const P extends readonly PopulatePath<R>[] = []>(where: Condition[], options?: PopulateOptions<P>): Promise<Populated<T, R, P[number]> | null>;
  /** A page of records for explicit conditions, sort, limit and offset, with the total. */
  list<const P extends readonly PopulatePath<R>[] = []>(query: ListQuery, options?: PopulateOptions<P>): Promise<ListResult<Populated<T, R, P[number]>>>;
  /** Records for `ids` in that order, skipping missing ids and repeating none; `include` populates like `populate`. */
  findByIds<const P extends readonly PopulatePath<R>[] = []>(ids: readonly string[], options?: { include?: P }): Promise<Populated<T, R, P[number]>[]>;
  /** Applies a partial change (reference arrays also take `{ add, remove }`) and returns the record. */
  update(id: string, changes: U, options?: WriteOptions): Promise<T>;
  /** Replaces every writable field and returns the record. */
  replace(id: string, data: C, options?: WriteOptions): Promise<T>;
  /** Deletes the record, applying the `@onDelete` rules of the records that reference it; `ifMatch` makes it conditional. */
  delete(id: string, options?: Pick<WriteOptions, "ifMatch" | "tagOf">): Promise<void>;
  /** Populates reference paths on records already loaded, e.g. results of a custom endpoint. */
  populate(records: T[], paths: readonly string[]): Promise<T[]>;
  /** Creates a record whose framework-managed fields (e.g. a file's metadata) and id are already known. */
  createWith(id: string, managed: Record<string, unknown>, data: unknown): Promise<T>;
  /** Replaces a record like `replace`, also setting framework-managed fields. */
  replaceWith(id: string, managed: Record<string, unknown>, data: unknown): Promise<T>;
  /** A fluent query filtered by the lambda's conditions. */
  where(lambda: QueryLambda<T>): Query<T, R>;
  /** A fluent query over every record. */
  query(): Query<T, R>;
  /** Whether any record exists, or with a condition, whether any record satisfies it; `query().any(lambda)`. */
  any(lambda?: QueryLambda<T>): Promise<boolean>;
  /** Whether every record satisfies the condition (true when there are none); `query().all(lambda)`. */
  all(lambda: QueryLambda<T>): Promise<boolean>;
  /** Whether no record exists, or with a condition, whether no record satisfies it; `query().none(lambda)`. */
  none(lambda?: QueryLambda<T>): Promise<boolean>;
  /** The number of records, or with a condition, of records satisfying it; `where(lambda).count()`. */
  count(lambda?: QueryLambda<T>): Promise<number>;
  /**
   * A fluent query over the records the reference array `field` of record `id` lists, e.g.
   * `related(orgId, "members")`. It has no records when that record does not exist, and its `aggregate` then resolves
   * null.
   */
  related<K extends RelatedField<R>>(id: string, field: K): Query<RelatedRecord<R, K>, RelatedReferences<R, K>, null>;
}

/** The read methods of a repository, the only ones offered for records the framework writes (e.g. job runs). */
export const READ_METHODS = ["findById", "findOne", "list", "where", "query", "any", "all", "none", "count"] as const;

/** A repository that only reads: `findById`, `findOne`, `list`, `where`, `query`, `any`, `all`, `none` and `count`. */
export type ReadRepository<T extends EntityRecord = EntityRecord, R = Record<never, never>> = Pick<Repository<T, R>, (typeof READ_METHODS)[number]>;

/** The read methods of a repository, without its write methods. */
export function readRepository<T extends EntityRecord, R>(repository: Repository<T, R>): ReadRepository<T, R> {
  return Object.fromEntries(READ_METHODS.map((method) => [method, repository[method].bind(repository)])) as unknown as ReadRepository<T, R>;
}

/** Repositories keyed by repository key; entities with an explicit schema are nested under the schema key. */
export type RepositoryRegistry = Record<string, Repository | Record<string, Repository>>;

/** Builds the query backend of a repository's entity over the related records of a scope. */
type RelatedBackend = (scope: RelatedScope) => QueryBackend;

/** The related-records backend of each repository, kept off its public methods. */
const relatedBackends = new WeakMap<Repository, RelatedBackend>();

/** The fields a write sets, as the `changed` list of an observed write that did not read the record before it. */
const changedKeys = (changes: Record<string, unknown>) => Object.keys(changes).filter((key) => key !== "updatedAt");

/** Returns the current time, strictly after `previous` so ordering by update time is always meaningful. */
function nextTimestamp(previous?: Date): Date {
  const now = Date.now();
  return new Date(previous && now <= previous.getTime() ? previous.getTime() + 1 : now);
}

async function mapUniqueViolation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof UniqueViolationError) {
      throw new HttpError(409, "Value already exists", {
        details: [{ field: error.field, message: "Value already exists" }],
      });
    }
    throw error;
  }
}

/** What a repository of one entity precomputes from the model: shared by the repositories of every adapter. */
export interface EntityPlan {
  /** Whether the entity has derived relation sides. */
  hasDerived: boolean;
  /** Whether writes also change other records (relation sides or a moved 1-1 link), so they need a transaction. */
  syncsRelations: boolean;
  /** The reference fields to file entities the entity owns. */
  ownedFiles: ReturnType<typeof ownedFileFields>;
  /** Whether updates may remove replaced files. */
  cleansReplaced: boolean;
  /** Paths that are never returned. */
  hiddenPaths: string[];
  /** Whether a delete (with its cascades) may remove stored objects. */
  cleansOnDelete: boolean;
  /** Whether an update needs nothing from the stored record. */
  writesDirectly: boolean;
}

/**
 * Builds the plan of an entity's repositories. It is built once per entity and repository settings, so creating the
 * repositories of another adapter (a schema or a tenant database) costs only the repository objects.
 */
export const repositoryPlans = {
  build(model: EntityModel, models: EntityModel[], options: RepositoryOptions): EntityPlan {
    const cleanup = options.fileCleanup;
    const hasDerived = derivedFields(model).length > 0;
    const syncsRelations = hasDerived || model.fields.some((field) => field.onConflict === "replace");
    const ownedFiles = ownedFileFields(model, models);
    const cleansReplaced = Boolean(cleanup?.deleteReplaced) && (ownedFiles.length > 0 || model.file !== undefined);
    const cleansOnDelete = cascadedEntities(model, models).some((entity) => cleansFilesOf(entity, models, cleanup));
    return { hasDerived, syncsRelations, ownedFiles, cleansReplaced, hiddenPaths: alwaysHiddenPaths(model.fields), cleansOnDelete, writesDirectly: !syncsRelations && !cleansReplaced };
  },
};

/** Whether deleting a record of `entity` removes stored objects: its own, or those of the files it owns. */
function cleansFilesOf(entity: EntityModel, models: EntityModel[], cleanup: FileCleanupSettings | undefined): boolean {
  return Boolean(cleanup && ((entity.file && cleanup.deleteOnRemove) || (cleanup.deleteWithOwner && ownedFileFields(entity, models).length > 0)));
}

/** The plans of each set of repository settings, by entity. */
const plans = new WeakMap<RepositoryOptions, WeakMap<EntityModel, EntityPlan>>();

function planOf(model: EntityModel, models: EntityModel[], options: RepositoryOptions): EntityPlan {
  let byModel = plans.get(options);
  if (!byModel) {
    byModel = new WeakMap();
    plans.set(options, byModel);
  }
  let plan = byModel.get(model);
  if (!plan) {
    plan = repositoryPlans.build(model, models, options);
    byModel.set(model, plan);
  }
  return plan;
}

export function createRepository(
  model: EntityModel,
  adapter: DatabaseAdapter,
  models: EntityModel[] = [model],
  repositoryOptions: RepositoryOptions = {},
): Repository {
  // With a tracer, every record read, write and aggregate of this repository runs in a span of its own.
  if (tracingEnabled()) adapter = tracedAdapter(adapter);
  const maxDepth = repositoryOptions.populateMaxDepth ?? 2;
  const { hasDerived, syncsRelations, ownedFiles, cleansReplaced, hiddenPaths, cleansOnDelete, writesDirectly } = planOf(model, models, repositoryOptions);
  const atomically = <T>(fn: () => Promise<T>) => (syncsRelations ? runInTransaction(adapter, fn) : fn());
  const cleanup = repositoryOptions.fileCleanup;
  /** Runs a change, then deletes the objects it queued; nothing is deleted when the change fails. */
  const settle = async <T>(fn: (queue: StoredObject[]) => Promise<T>): Promise<T> => {
    const queue: StoredObject[] = [];
    const result = await fn(queue);
    if (cleanup && queue.length > 0) await deleteObjects(queue, cleanup);
    return result;
  };
  const compute = (entity: EntityModel, records: StoredRecord[]) => withFileUrls(entity, records, repositoryOptions.fileAccess);
  const withReferences = async (stored: StoredRecord[], options: ReadOptions = {}): Promise<StoredRecord[]> => {
    const records = await compute(model, hasDerived ? await deriveRelations(model, stored, models, adapter) : stored);
    const paths = [...(options.populate ?? [])];
    if (paths.length === 0) return records;
    assertPopulatePaths(model, models, paths, maxDepth);
    return populateRecords(model, records, paths, models, adapter, compute);
  };
  /**
   * Updates a record that relation sync changes. Observers of its entity get a `touch` change, queued in `pending`
   * when given (so the write's own change is reported first), reported at once otherwise.
   */
  const touchInto =
    (pending?: (() => Promise<void>)[]): Touch =>
    async (target, record, changes, changed) => {
      const after = await adapter.updateById(target, record.id, { ...changes, updatedAt: nextTimestamp(record.updatedAt) });
      const observed = observersOf(target);
      if (!observed || !after) return;
      const names = Object.keys(changes);
      const report = () => reportChange(observed, { entity: target, operation: "updated", id: record.id, before: record, after, changed: names.length > 0 ? names : (changed ?? ["updatedAt"]), cause: "touch" });
      if (pending) pending.push(report);
      else await report();
    };
  const present = (record: StoredRecord, options: ReadOptions = {}): EntityRecord => {
    if (options.includeHidden || hiddenPaths.length === 0) return record;
    return project(record, { exclude: hiddenPaths }) as EntityRecord;
  };

  const checkReferences = async (value: Record<string, unknown>) => {
    await assertReferencesExist(model, value, models, adapter);
    await assertReferencedFilesAllowed(model, value, models, adapter);
  };

  const validate = async (body: unknown, mode: ValidationMode): Promise<Record<string, unknown>> => {
    const result = validateBody(model, body, mode);
    if (!result.ok) throw new HttpError(400, "Invalid body", { details: result.details });
    await checkReferences(result.value);
    return result.value;
  };

  const notFound = () => new HttpError(404, `${model.entityName} not found`);

  const storedRecord = async (id: string): Promise<StoredRecord> => {
    const record = await adapter.findById(model, id);
    if (!record) throw notFound();
    return record;
  };
  const derived = async (record: StoredRecord): Promise<StoredRecord> => (hasDerived ? (await deriveRelations(model, [record], models, adapter))[0]! : record);
  const existing = async (id: string): Promise<StoredRecord> => derived(await storedRecord(id));
  /** The stored record before a write, read inside the write's transaction with a row lock where the adapter has one. */
  const lockedRecord = async (id: string): Promise<StoredRecord> => {
    await adapter.lockForUpdate?.(model, id);
    return storedRecord(id);
  };

  /**
   * The response of a write, built from the record the adapter returned. Syncing relation sides can touch the record
   * again, so with derived sides it is read back with them.
   */
  const written = async (record: StoredRecord, options?: ReadOptions): Promise<EntityRecord> =>
    present((await compute(model, [hasDerived ? await existing(record.id) : record]))[0]!, options);

  /** Deletes a file record that nothing references any more, queueing its object. */
  const removeUnreferencedFile = async (target: EntityModel, id: string, queue: StoredObject[]) => {
    if (await isFileReferenced(target, id, models, adapter)) return;
    const record = await adapter.findById(target, id);
    if (!record) return;
    await executeDeletePlan(await planDelete(target, id, models, adapter, record), adapter, nextTimestamp);
    const object = objectOf(target, record);
    if (object) queue.push(object);
  };

  const removeReplaced = async (current: StoredRecord, changes: Record<string, unknown>, queue: StoredObject[]) => {
    if (!cleanup?.deleteReplaced) return;
    if (model.file && typeof changes.storageKey === "string" && changes.storageKey !== current.storageKey) {
      const object = objectOf(model, current);
      if (object) queue.push(object);
    }
    for (const { field, target } of ownedFiles) {
      if (!(field.name in changes)) continue;
      const kept = new Set(referencedIds(changes[field.name]));
      for (const previous of referencedIds(current[field.name])) {
        if (!kept.has(previous)) await removeUnreferencedFile(target, previous, queue);
      }
    }
  };

  /** Throws the 412 of a conditional write when `ifMatch` lists no current tag of the record. */
  const checkIfMatch = (current: StoredRecord, options: Pick<WriteOptions, "ifMatch" | "tagOf">) => {
    const tag = (options.tagOf ?? etagOf)(current);
    if (!ifMatchTag(options.ifMatch!, tag)) throw preconditionFailed(tag);
  };
  /** The error of a conditional write that lost the race: 412 with the new tag, or 404 when the record is gone. */
  const lostRace = async (id: string, options: Pick<WriteOptions, "tagOf">) => {
    const now = await adapter.findById(model, id);
    return now ? preconditionFailed((options.tagOf ?? etagOf)(now)) : notFound();
  };

  const write = async (id: string, changes: Record<string, unknown>, options?: WriteOptions, queue: StoredObject[] = []): Promise<EntityRecord> => {
    assertWritable(adapter);
    const observed = observersOf(model);
    const conditional = options?.ifMatch !== undefined;
    if (writesDirectly && !observed?.inTransaction && !conditional) {
      // One conditional update: `updatedAt` must move forward, so a record stored at or after this instant (or a
      // missing one) falls through to the read below, which answers 404 or picks a later timestamp.
      const at = nextTimestamp();
      const updated = await mapUniqueViolation(() =>
        adapter.updateById(model, id, { ...withoutDerived(model, changes), updatedAt: at }, [{ field: "updatedAt", op: "lt", value: at }]),
      );
      if (updated) {
        if (observed) await reportChange(observed, { entity: model, operation: "updated", id, before: null, after: updated, changed: changedKeys(changes), cause: "write" });
        return written(updated, options);
      }
    }
    const inTransaction = cleansReplaced || observed?.inTransaction || conditional ? <T>(fn: () => Promise<T>) => runInTransaction(adapter, fn) : atomically;
    return inTransaction(async () => {
      const before = observed?.needsBefore || conditional ? await lockedRecord(id) : undefined;
      if (conditional) checkIfMatch(before!, options!);
      const current = before ? await derived(before) : await existing(id);
      const touched: (() => Promise<void>)[] = [];
      const touch = touchInto(observed ? touched : undefined);
      await releaseOneToOne(model, id, changes, adapter, touch);
      // A conditional write also requires the `updatedAt` it checked, so of two writes with one tag only one succeeds.
      const updated = await mapUniqueViolation(() =>
        adapter.updateById(
          model,
          id,
          { ...withoutDerived(model, changes), updatedAt: nextTimestamp(current.updatedAt) },
          conditional ? [{ field: "updatedAt", op: "eq", value: before!.updatedAt }] : undefined,
        ),
      );
      if (!updated) throw conditional ? await lostRace(id, options!) : notFound();
      if (hasDerived) await mapUniqueViolation(() => writeDerived(model, id, changes, models, adapter, touch));
      await removeReplaced(current, changes, queue);
      if (observed) {
        await reportChange(observed, { entity: model, operation: "updated", id, before: before ?? null, after: updated, ...(before ? {} : { changed: changedKeys(changes) }), cause: "write" });
        for (const report of touched) await report();
      }
      return written(updated, options);
    });
  };

  const createRecord = async (id: string, managed: Record<string, unknown>, data: unknown, options?: ReadOptions) => {
      assertWritable(adapter);
      const value = await validate(data, "create");
      for (const field of model.fields) {
        if (value[field.name] === undefined && field.default !== undefined) {
          value[field.name] = structuredClone(field.default);
        }
        if (value[field.name] === undefined && field.type === "refArray") value[field.name] = [];
      }
      const at = nextTimestamp();
      const record: StoredRecord = { ...value, ...managed, id, createdAt: at, updatedAt: at };
      const observed = observersOf(model);
      return (observed?.inTransaction ? <T>(fn: () => Promise<T>) => runInTransaction(adapter, fn) : atomically)(async () => {
        const touched: (() => Promise<void>)[] = [];
        const touch = touchInto(observed ? touched : undefined);
        await releaseOneToOne(model, undefined, value, adapter, touch);
        const inserted = await mapUniqueViolation(() => adapter.insert(model, withoutDerived(model, record) as StoredRecord));
        if (hasDerived) await mapUniqueViolation(() => writeDerived(model, record.id, value, models, adapter, touch));
        if (observed) {
          await reportChange(observed, { entity: model, operation: "created", id: inserted.id, before: null, after: inserted, cause: "write" });
          for (const report of touched) await report();
        }
        return written(inserted, options);
      });
  };

  const replaceRecord = async (id: string, managed: Record<string, unknown>, data: unknown, options?: WriteOptions) => {
    const value = await validate(data, "replace");
    const changes: Record<string, unknown> = {};
    for (const field of model.fields) {
      if (field.readOnly) continue;
      changes[field.name] = value[field.name] ?? (field.type === "refArray" ? [] : null);
    }
    return settle((queue) => write(id, { ...changes, ...managed }, options, queue));
  };

  const updateRecord = async (id: string, changes: unknown, options: WriteOptions | undefined, queue: StoredObject[]) => {
    const result = validateBody(model, changes, "patch");
    if (!result.ok) throw new HttpError(400, "Invalid body", { details: result.details });
    const value = result.value;
    const hasChange = Object.values(value).some((item) => item instanceof ReferenceArrayChange);
    if (!hasChange) {
      await checkReferences(value);
      return write(id, value, options, queue);
    }
    // Add/remove operations read the stored list and write the result atomically.
    return runInTransaction(adapter, async () => {
      await adapter.lockForUpdate?.(model, id);
      const current = await existing(id);
      const details: { field: string; message: string }[] = [];
      for (const field of model.fields) {
        const change = value[field.name];
        if (!(change instanceof ReferenceArrayChange)) continue;
        const list = change.applyTo((current[field.name] as string[] | null) ?? []);
        if (field.minLength !== undefined && list.length < field.minLength) {
          details.push({ field: field.name, message: `Must have at least ${itemCount(field.minLength)}` });
        }
        if (field.maxLength !== undefined && list.length > field.maxLength) {
          details.push({ field: field.name, message: `Must have at most ${itemCount(field.maxLength)}` });
        }
        value[field.name] = list;
      }
      if (details.length > 0) throw new HttpError(400, "Invalid body", { details });
      await checkReferences(value);
      return write(id, value, options, queue);
    });
  };

  const resolve = (where: Condition[]) => resolveDerivedConditions(model, where, models, adapter);

  /** A page of records; without `withTotal`, the matches are not counted and `total` is the page size. */
  const listRecords = async (
    query: ListQuery,
    options: ReadOptions | undefined,
    withTotal: boolean,
    find: (where: Condition[]) => Promise<FindManyResult> = (where) =>
      adapter.findMany(model, { ...query, where, withTotal, ...(options?.omit?.length ? { omit: options.omit } : {}) }),
  ): Promise<ListResult<EntityRecord>> => {
    const { data, total } = await find(await resolve(query.where));
    const populated = await withReferences(data, options);
    return { data: populated.map((record) => present(record, options)), total, limit: query.limit, offset: query.offset };
  };

  /** The aggregates with the conditions of their counts resolved like the query's own. */
  const resolveAggregates = async (aggregates: Record<string, Aggregate>): Promise<Record<string, Aggregate>> => {
    const resolved: Record<string, Aggregate> = {};
    for (const [name, aggregate] of Object.entries(aggregates)) {
      resolved[name] = aggregate.fn === "count" && aggregate.where ? { fn: "count", where: await resolve(aggregate.where) } : aggregate;
    }
    return resolved;
  };

  const toArrayMax = repositoryOptions.toArrayMax ?? DEFAULT_TO_ARRAY_MAX;
  const backend: QueryBackend = {
    model,
    toArrayMax,
    list: (query, populate, withTotal) => listRecords(query, { populate }, withTotal),
    count: async (where) => adapter.count(model, await resolve(where)),
    aggregate: async (where, aggregates) => {
      if (Object.keys(aggregates).length === 0) return {};
      return adapter.aggregate(model, await resolve(where), await resolveAggregates(aggregates));
    },
    notFound,
  };

  /**
   * The backend over the records of this entity that a reference array of another record lists. Adapters without
   * related queries get the same results from the owner's array: the owner is read first, then its ids are filtered.
   */
  const relatedBackend: RelatedBackend = (scope) => {
    const listedIds = async (): Promise<string[] | null> => {
      const owner = await adapter.findById(scope.owner, scope.id);
      return owner ? ((owner[scope.field] as string[] | null) ?? []) : null;
    };
    const byIds = (ids: string[], where: Condition[]): Condition[] => [{ field: "id", op: "in", value: ids }, ...where];
    const findRelated = async (query: ListQuery, where: Condition[], withTotal: boolean): Promise<FindManyResult> => {
      if (adapter.findRelated) return adapter.findRelated(scope, { ...query, where, withTotal });
      const ids = await listedIds();
      if (!ids || ids.length === 0) return { data: [], total: 0 };
      return adapter.findMany(model, { ...query, where: byIds(ids, where), withTotal });
    };
    const aggregateRelated = async (where: Condition[], aggregates: Record<string, Aggregate>): Promise<AggregateValues | null> => {
      if (adapter.aggregateRelated) return adapter.aggregateRelated(scope, where, aggregates);
      const ids = await listedIds();
      if (!ids) return null;
      return adapter.aggregate(model, byIds(ids, where), aggregates);
    };
    return {
      model,
      toArrayMax,
      list: (query, populate, withTotal) => listRecords(query, { populate }, withTotal, (where) => findRelated(query, where, withTotal)),
      count: async (where) => {
        const resolved = await resolve(where);
        if (adapter.countRelated) return adapter.countRelated(scope, resolved);
        const ids = await listedIds();
        return ids && ids.length > 0 ? adapter.count(model, byIds(ids, resolved)) : 0;
      },
      aggregate: async (where, aggregates) => {
        // Without expressions the result still tells whether the owner exists.
        const empty = Object.keys(aggregates).length === 0;
        const values = await aggregateRelated(await resolve(where), empty ? { owner: { fn: "count" } } : await resolveAggregates(aggregates));
        return values && empty ? {} : values;
      },
      notFound,
    };
  };

  /**
   * Deletes the record `id` (stored as `record`) and what its delete plan removes or changes; with file cleanup, queues
   * the stored objects to remove once the change succeeded.
   */
  const deleteRecord = async (id: string, record: StoredRecord, queue: StoredObject[]): Promise<void> => {
    const plan = await planDelete(model, id, models, adapter, record);
    if (!cleansOnDelete) {
      await executeDeletePlan(plan, adapter, nextTimestamp);
      return;
    }
    const owned: { target: EntityModel; id: string }[] = [];
    for (const deleted of plan.deletions) {
      if (!cleansFilesOf(deleted.model, models, cleanup)) continue;
      const stored = deleted.model === model && deleted.id === id ? record : await adapter.findById(deleted.model, deleted.id);
      if (!stored) continue;
      const object = deleted.model.file && cleanup!.deleteOnRemove ? objectOf(deleted.model, stored) : undefined;
      if (object) queue.push(object);
      if (!cleanup!.deleteWithOwner) continue;
      for (const { field, target } of ownedFileFields(deleted.model, models)) {
        for (const fileId of referencedIds(stored[field.name])) owned.push({ target, id: fileId });
      }
    }
    await executeDeletePlan(plan, adapter, nextTimestamp);
    for (const file of owned) await removeUnreferencedFile(file.target, file.id, queue);
  };

  /** The related-records backend of each reference array followed so far, by field name. */
  const relatedTargets = new Map<string, RelatedBackend>();

  const repository: Repository = {
    where(lambda) {
      return createQuery(backend, { where: conditionsOf(model, lambda), sort: [], skip: 0 });
    },

    query() {
      return createQuery(backend, { where: [], sort: [], skip: 0 });
    },

    any: (lambda) => repository.query().any(lambda),
    all: (lambda) => repository.query().all(lambda),
    none: (lambda) => repository.query().none(lambda),
    count: (lambda) => (lambda === undefined ? repository.query() : repository.where(lambda)).count(),

    related(id, field) {
      const definition = model.fields.find((candidate) => candidate.name === field);
      if (!definition || definition.type !== "refArray" || definition.storage !== "relation") {
        throw new Error(`related() follows the stored reference arrays of ${model.entityName}, and "${field}" is not one`);
      }
      const target = models.find((candidate) => candidate.key === definition.target);
      if (!target) throw new Error(`Unknown entity ${definition.target}`);
      let targetBackend = relatedTargets.get(field);
      if (!targetBackend) {
        targetBackend = relatedBackends.get(target === model ? repository : createRepository(target, adapter, models, repositoryOptions))!;
        relatedTargets.set(field, targetBackend);
      }
      return createQuery(targetBackend({ owner: model, id, field, target }), { where: [], sort: [], skip: 0 }) as never;
    },

    async findByIds(ids, options = {}) {
      const unique = [...new Set(ids)];
      const found = new Map<string, EntityRecord>();
      for (let start = 0; start < unique.length; start += FIND_BY_IDS_BATCH) {
        const batch = unique.slice(start, start + FIND_BY_IDS_BATCH);
        const { data } = await listRecords(
          { where: [{ field: "id", op: "in", value: batch }], sort: [{ field: "id", direction: "asc" }], limit: batch.length, offset: 0 },
          { populate: options.include ?? [] },
          false,
        );
        for (const record of data) found.set(record.id, record);
      }
      return unique.flatMap((id) => (found.has(id) ? [found.get(id)!] : []));
    },

    async create(data, options) {
      return createRecord(Bun.randomUUIDv7(), {}, data, options);
    },

    async createWith(id, managed, data) {
      return createRecord(id, managed, data);
    },

    async replaceWith(id, managed, data) {
      return replaceRecord(id, managed, data);
    },

    async findById(id, options) {
      const record = await adapter.findById(model, id, options?.omit?.length ? { omit: options.omit } : undefined);
      if (!record) return null;
      const [populated] = await withReferences([record], options);
      return present(populated!, options);
    },

    async findOne(where, options) {
      const record = await adapter.findOne(model, await resolveDerivedConditions(model, where, models, adapter));
      if (!record) return null;
      const [populated] = await withReferences([record], options);
      return present(populated!, options);
    },

    async list(query, options) {
      return listRecords(query, options, true);
    },

    async populate(records, paths) {
      return (await withReferences(records as StoredRecord[], { populate: paths })).map((record) => present(record));
    },

    async update(id, changes, options) {
      return settle((queue) => updateRecord(id, changes, options, queue));
    },

    async replace(id, data, options) {
      return replaceRecord(id, {}, data, options);
    },

    async delete(id, options) {
      assertWritable(adapter);
      const observed = observersOf(model);
      if (options?.ifMatch !== undefined) {
        // The check, a conditional write holding the record, and the delete plan run in one transaction.
        await settle((queue) =>
          runInTransaction(adapter, async () => {
            const before = await lockedRecord(id);
            checkIfMatch(before, options);
            const held = await adapter.updateById(model, id, { updatedAt: before.updatedAt }, [{ field: "updatedAt", op: "eq", value: before.updatedAt }]);
            if (!held) throw await lostRace(id, options);
            await deleteRecord(id, await derived(before), queue);
            if (observed) await reportChange(observed, { entity: model, operation: "deleted", id, before, after: null, cause: "write" });
          }),
        );
        return;
      }
      if (observed) {
        // Observed deletes read the record inside the transaction, so `before` is what the delete removed.
        await settle((queue) =>
          runInTransaction(adapter, async () => {
            const before = await lockedRecord(id);
            await deleteRecord(id, await derived(before), queue);
            await reportChange(observed, { entity: model, operation: "deleted", id, before, after: null, cause: "write" });
          }),
        );
        return;
      }
      const record = await existing(id);
      if (!cleansOnDelete) {
        await executeDeletePlan(await planDelete(model, id, models, adapter, record), adapter, nextTimestamp);
        return;
      }
      await settle((queue) => runInTransaction(adapter, () => deleteRecord(id, record, queue)));
    },
  };

  relatedBackends.set(repository, relatedBackend);
  return repository;
}

export function createRepositories(
  models: EntityModel[],
  adapter: DatabaseAdapter,
  options: RepositoryOptions = {},
): RepositoryRegistry {
  const registry: RepositoryRegistry = {};
  for (const model of models) {
    // Link entities store N-N relations internally and have no repository of their own.
    if (model.link) continue;
    const full = createRepository(model, adapter, models, options);
    // Records of system entities are written by the framework; code only reads them.
    const repository = model.system ? (readRepository(full) as Repository) : full;
    if (model.schemaKey) {
      const nested = (registry[model.schemaKey] ??= {}) as Record<string, Repository>;
      nested[model.repoKey] = repository;
    } else {
      registry[model.repoKey] = repository;
    }
  }
  // `repos.transaction(fn)`, kept out of the registry's keys so code listing the repositories never sees it.
  Object.defineProperty(registry, "transaction", { value: <T>(fn: () => Promise<T>) => publicTransaction(adapter, fn), enumerable: false });
  return registry;
}

export function repositoryFor(registry: RepositoryRegistry, model: EntityModel): Repository {
  const scope = model.schemaKey ? (registry[model.schemaKey] as Record<string, Repository> | undefined) : registry;
  const repository = scope?.[model.repoKey] as Repository | undefined;
  if (!repository) throw new Error(`No repository for entity ${model.entityName}`);
  return repository;
}

/** The models and options `repositoriesFor` builds registries with, and the registries built so far, by adapter. */
interface RegistrySettings {
  models: EntityModel[];
  options: RepositoryOptions;
  registries: WeakMap<DatabaseAdapter, RepositoryRegistry>;
}

let registrySettings: RegistrySettings | undefined;

/** Sets the models and repository options `repositoriesFor` uses, forgetting the registries built before; `createApp` calls it. */
export function configureRepositories(models: EntityModel[], options: RepositoryOptions = {}): void {
  registrySettings = { models, options, registries: new WeakMap() };
}

/** The models `repositoriesFor` builds registries with; throws before a service configured them. */
export function configuredModels(): EntityModel[] {
  if (!registrySettings) throw new Error("No entity models are configured yet: the service has not started");
  return registrySettings.models;
}

/**
 * The repository registry of an adapter instance, with the shape `createRepositories` builds (schema-bound repositories
 * nested by schema key), built on first use and kept for that adapter: asking twice for one adapter returns the same
 * object. Registries of different adapters share the entity plans, so another registry costs only its repository objects.
 */
export function repositoriesFor(adapter: DatabaseAdapter): RepositoryRegistry {
  const settings = registrySettings;
  if (!settings) throw new Error("repositoriesFor() needs a running service: no entity models are configured yet");
  let registry = settings.registries.get(adapter);
  if (!registry) {
    registry = createRepositories(settings.models, adapter, settings.options);
    settings.registries.set(adapter, registry);
  }
  return registry;
}

/** The registry path of an entity's repository, computed once: the repository key, under the schema key when it has one. */
export function repositoryLookup(model: EntityModel): (registry: RepositoryRegistry) => Repository {
  const { schemaKey, repoKey } = model;
  const missing = () => new Error(`No repository for entity ${model.entityName}`);
  if (schemaKey) {
    return (registry) => {
      const repository = (registry[schemaKey] as Record<string, Repository> | undefined)?.[repoKey];
      if (!repository) throw missing();
      return repository;
    };
  }
  return (registry) => {
    const repository = registry[repoKey] as Repository | undefined;
    if (!repository) throw missing();
    return repository;
  };
}
