import { UniqueViolationError, type DatabaseAdapter, type StoredRecord } from "./adapter.ts";
import { HttpError } from "./errors.ts";
import { alwaysHiddenPaths, type EntityModel } from "./model.ts";
import { project } from "./projection.ts";
import { assertPopulatePaths, populateRecords } from "./populate.ts";
import type { Condition, ListQuery } from "./query.ts";
import { assertReferencesExist, executeDeletePlan, planDelete } from "./referential-integrity.ts";
import { validateBody, type ValidationMode } from "./validation.ts";

export type EntityRecord = StoredRecord;

export interface ReadOptions {
  includeHidden?: boolean;
  /** Reference paths to replace with the referenced records, e.g. `organization` or `organization.logo`. */
  populate?: readonly string[];
}

export interface RepositoryOptions {
  /** Maximum number of segments in a populate path (default 2). */
  populateMaxDepth?: number;
}

export interface ListResult<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

/** `T` with the populated reference fields `K` typed as their referenced records (`R[K]`) or null. */
export type Populated<T, R, K extends string> = [K & keyof R] extends [never]
  ? T
  : Omit<T, K & keyof R> & { [Field in K & keyof R]: R[Field] | null };

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
  const withReferences = async (records: StoredRecord[], options: ReadOptions = {}): Promise<StoredRecord[]> => {
    const paths = [...(options.populate ?? [])];
    if (paths.length === 0) return records;
    assertPopulatePaths(model, models, paths, maxDepth);
    return populateRecords(model, records, paths, models, adapter);
  };
  const hiddenPaths = alwaysHiddenPaths(model.fields);

  const present = (record: StoredRecord, options: ReadOptions = {}): EntityRecord => {
    if (options.includeHidden || hiddenPaths.length === 0) return record;
    return project(record, { exclude: hiddenPaths }) as EntityRecord;
  };

  const validate = async (body: unknown, mode: ValidationMode): Promise<Record<string, unknown>> => {
    const result = validateBody(model, body, mode);
    if (!result.ok) throw new HttpError(400, "Invalid body", { details: result.details });
    await assertReferencesExist(model, result.value, models, adapter);
    return result.value;
  };

  const notFound = () => new HttpError(404, `${model.entityName} not found`);

  const existing = async (id: string): Promise<StoredRecord> => {
    const record = await adapter.findById(model, id);
    if (!record) throw notFound();
    return record;
  };

  const write = async (id: string, changes: Record<string, unknown>, options?: ReadOptions): Promise<EntityRecord> => {
    const current = await existing(id);
    const updated = await mapUniqueViolation(() =>
      adapter.updateById(model, id, { ...changes, updatedAt: nextTimestamp(current.updatedAt) }),
    );
    if (!updated) throw notFound();
    return present(await existing(id), options);
  };

  const repository: Repository = {
    async create(data, options) {
      const value = await validate(data, "create");
      for (const field of model.fields) {
        if (value[field.name] === undefined && field.default !== undefined) {
          value[field.name] = structuredClone(field.default);
        }
      }
      const at = nextTimestamp();
      const record: StoredRecord = { ...value, id: Bun.randomUUIDv7(), createdAt: at, updatedAt: at };
      return present(await mapUniqueViolation(() => adapter.insert(model, record)), options);
    },

    async findById(id, options) {
      const record = await adapter.findById(model, id);
      if (!record) return null;
      const [populated] = await withReferences([record], options);
      return present(populated!, options);
    },

    async findOne(where, options) {
      const record = await adapter.findOne(model, where);
      if (!record) return null;
      const [populated] = await withReferences([record], options);
      return present(populated!, options);
    },

    async list(query, options) {
      const { data, total } = await adapter.findMany(model, query);
      const populated = await withReferences(data, options);
      return { data: populated.map((record) => present(record, options)), total, limit: query.limit, offset: query.offset };
    },

    async populate(records, paths) {
      return (await withReferences(records as StoredRecord[], { populate: paths })).map((record) => present(record));
    },

    async update(id, changes, options) {
      return write(id, await validate(changes, "patch"), options);
    },

    async replace(id, data, options) {
      const value = await validate(data, "replace");
      const changes: Record<string, unknown> = {};
      for (const field of model.fields) changes[field.name] = value[field.name] ?? null;
      return write(id, changes, options);
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
