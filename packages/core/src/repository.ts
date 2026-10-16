import { UniqueViolationError, type DatabaseAdapter, type StoredRecord } from "./adapter.ts";
import { HttpError } from "./errors.ts";
import { alwaysHiddenPaths, type EntityModel } from "./model.ts";
import { project } from "./projection.ts";
import { withFileUrls, type FileAccessSettings } from "./files/access.ts";
import { assertReferencedFilesAllowed } from "./files/field-limits.ts";
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
import { assertReferencesExist, executeDeletePlan, planDelete } from "./referential-integrity.ts";
import { ReferenceArrayChange, validateBody, type ValidationMode } from "./validation.ts";

export type EntityRecord = StoredRecord;

export interface ReadOptions {
  includeHidden?: boolean;
  /** Reference paths to replace with the referenced records, e.g. `organization` or `organization.logo`. */
  populate?: readonly string[];
}

export interface RepositoryOptions {
  /** Maximum number of segments in a populate path (default 2). */
  populateMaxDepth?: number;
  /** Storages and access settings used to compute the `url` of file records. */
  fileAccess?: FileAccessSettings;
}

export interface ListResult<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

/** `T` with the populated reference fields `K` typed as `R[K]`: the referenced record (or null), or an array of records. */
export type Populated<T, R, K extends string> = [K & keyof R] extends [never]
  ? T
  : Omit<T, K & keyof R> & { [Field in K & keyof R]: R[Field] };

export type PopulateOptions<P extends readonly string[]> = Omit<ReadOptions, "populate"> & { populate?: P };

/**
 * Repository of one entity. `R` maps reference fields to the referenced record types, so populated reads are typed.
 */
export interface Repository<T extends EntityRecord = EntityRecord, R = Record<never, never>> {
  create(data: unknown, options?: ReadOptions): Promise<T>;
  findById<const P extends readonly string[] = []>(id: string, options?: PopulateOptions<P>): Promise<Populated<T, R, P[number]> | null>;
  findOne<const P extends readonly string[] = []>(where: Condition[], options?: PopulateOptions<P>): Promise<Populated<T, R, P[number]> | null>;
  list<const P extends readonly string[] = []>(query: ListQuery, options?: PopulateOptions<P>): Promise<ListResult<Populated<T, R, P[number]>>>;
  update(id: string, changes: unknown, options?: ReadOptions): Promise<T>;
  replace(id: string, data: unknown, options?: ReadOptions): Promise<T>;
  delete(id: string): Promise<void>;
  /** Populates reference paths on records already loaded, e.g. results of a custom endpoint. */
  populate(records: T[], paths: readonly string[]): Promise<T[]>;
  /** Creates a record whose framework-managed fields (e.g. a file's metadata) and id are already known. */
  createWith(id: string, managed: Record<string, unknown>, data: unknown): Promise<T>;
  /** Replaces a record like `replace`, also setting framework-managed fields. */
  replaceWith(id: string, managed: Record<string, unknown>, data: unknown): Promise<T>;
}

/** Repositories keyed by repository key; entities with an explicit schema are nested under the schema key. */
export type RepositoryRegistry = Record<string, Repository | Record<string, Repository>>;

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

export function createRepository(
  model: EntityModel,
  adapter: DatabaseAdapter,
  models: EntityModel[] = [model],
  repositoryOptions: RepositoryOptions = {},
): Repository {
  const maxDepth = repositoryOptions.populateMaxDepth ?? 2;
  const hasDerived = derivedFields(model).length > 0;
  // Writes only need a transaction when they also change other records (relation sides or a moved 1-1 link).
  const syncsRelations = hasDerived || model.fields.some((field) => field.onConflict === "replace");
  const atomically = <T>(fn: () => Promise<T>) => (syncsRelations ? adapter.transaction(fn) : fn());
  const compute = (entity: EntityModel, records: StoredRecord[]) => withFileUrls(entity, records, repositoryOptions.fileAccess);
  const withReferences = async (stored: StoredRecord[], options: ReadOptions = {}): Promise<StoredRecord[]> => {
    const records = await compute(model, hasDerived ? await deriveRelations(model, stored, models, adapter) : stored);
    const paths = [...(options.populate ?? [])];
    if (paths.length === 0) return records;
    assertPopulatePaths(model, models, paths, maxDepth);
    return populateRecords(model, records, paths, models, adapter, compute);
  };
  const touch: Touch = async (target, record, changes) => {
    await adapter.updateById(target, record.id, { ...changes, updatedAt: nextTimestamp(record.updatedAt) });
  };
  const hiddenPaths = alwaysHiddenPaths(model.fields);

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

  const existing = async (id: string): Promise<StoredRecord> => {
    const record = await adapter.findById(model, id);
    if (!record) throw notFound();
    return hasDerived ? (await deriveRelations(model, [record], models, adapter))[0]! : record;
  };

  const write = (id: string, changes: Record<string, unknown>, options?: ReadOptions): Promise<EntityRecord> =>
    atomically(async () => {
      const current = await existing(id);
      await releaseOneToOne(model, id, changes, adapter, touch);
      const updated = await mapUniqueViolation(() =>
        adapter.updateById(model, id, { ...withoutDerived(model, changes), updatedAt: nextTimestamp(current.updatedAt) }),
      );
      if (!updated) throw notFound();
      if (hasDerived) await mapUniqueViolation(() => writeDerived(model, id, changes, models, adapter, touch));
      return present((await compute(model, [await existing(id)]))[0]!, options);
    });

  const createRecord = async (id: string, managed: Record<string, unknown>, data: unknown, options?: ReadOptions) => {
      const value = await validate(data, "create");
      for (const field of model.fields) {
        if (value[field.name] === undefined && field.default !== undefined) {
          value[field.name] = structuredClone(field.default);
        }
        if (value[field.name] === undefined && field.type === "refArray") value[field.name] = [];
      }
      const at = nextTimestamp();
      const record: StoredRecord = { ...value, ...managed, id, createdAt: at, updatedAt: at };
      return atomically(async () => {
        await releaseOneToOne(model, undefined, value, adapter, touch);
        await mapUniqueViolation(() => adapter.insert(model, withoutDerived(model, record) as StoredRecord));
        if (hasDerived) await mapUniqueViolation(() => writeDerived(model, record.id, value, models, adapter, touch));
        return present((await compute(model, [await existing(record.id)]))[0]!, options);
      });
  };

  const replaceRecord = async (id: string, managed: Record<string, unknown>, data: unknown, options?: ReadOptions) => {
    const value = await validate(data, "replace");
    const changes: Record<string, unknown> = {};
    for (const field of model.fields) {
      if (field.readOnly) continue;
      changes[field.name] = value[field.name] ?? (field.type === "refArray" ? [] : null);
    }
    return write(id, { ...changes, ...managed }, options);
  };

  const repository: Repository = {
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
      const record = await adapter.findById(model, id);
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
      const where = await resolveDerivedConditions(model, query.where, models, adapter);
      const { data, total } = await adapter.findMany(model, { ...query, where });
      const populated = await withReferences(data, options);
      return { data: populated.map((record) => present(record, options)), total, limit: query.limit, offset: query.offset };
    },

    async populate(records, paths) {
      return (await withReferences(records as StoredRecord[], { populate: paths })).map((record) => present(record));
    },

    async update(id, changes, options) {
      const result = validateBody(model, changes, "patch");
      if (!result.ok) throw new HttpError(400, "Invalid body", { details: result.details });
      const value = result.value;
      const hasChange = Object.values(value).some((item) => item instanceof ReferenceArrayChange);
      if (!hasChange) {
        await checkReferences(value);
        return write(id, value, options);
      }
      // Add/remove operations read the stored list and write the result atomically.
      return adapter.transaction(async () => {
        await adapter.lockForUpdate?.(model, id);
        const current = await existing(id);
        const details: { field: string; message: string }[] = [];
        for (const field of model.fields) {
          const change = value[field.name];
          if (!(change instanceof ReferenceArrayChange)) continue;
          const list = change.applyTo((current[field.name] as string[] | null) ?? []);
          if (field.minLength !== undefined && list.length < field.minLength) {
            details.push({ field: field.name, message: `Must have at least ${field.minLength} items` });
          }
          if (field.maxLength !== undefined && list.length > field.maxLength) {
            details.push({ field: field.name, message: `Must have at most ${field.maxLength} items` });
          }
          value[field.name] = list;
        }
        if (details.length > 0) throw new HttpError(400, "Invalid body", { details });
        await checkReferences(value);
        return write(id, value, options);
      });
    },

    async replace(id, data, options) {
      return replaceRecord(id, {}, data, options);
    },

    async delete(id) {
      await existing(id);
      await executeDeletePlan(await planDelete(model, id, models, adapter), adapter, nextTimestamp);
    },
  };
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
    const repository = createRepository(model, adapter, models, options);
    if (model.schemaKey) {
      const nested = (registry[model.schemaKey] ??= {}) as Record<string, Repository>;
      nested[model.repoKey] = repository;
    } else {
      registry[model.repoKey] = repository;
    }
  }
  return registry;
}

export function repositoryFor(registry: RepositoryRegistry, model: EntityModel): Repository {
  const scope = model.schemaKey ? (registry[model.schemaKey] as Record<string, Repository> | undefined) : registry;
  const repository = scope?.[model.repoKey] as Repository | undefined;
  if (!repository) throw new Error(`No repository for entity ${model.entityName}`);
  return repository;
}
