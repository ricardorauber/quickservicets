import { UniqueViolationError, type DatabaseAdapter, type StoredRecord } from "./adapter.ts";
import { HttpError } from "./errors.ts";
import type { EntityModel } from "./model.ts";
import type { Condition, ListQuery } from "./query.ts";
import { assertReferencesExist, executeDeletePlan, planDelete } from "./referential-integrity.ts";
import { validateBody, type ValidationMode } from "./validation.ts";

export type EntityRecord = StoredRecord;

export interface ReadOptions {
  includeHidden?: boolean;
}

export interface ListResult<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface Repository<T extends EntityRecord = EntityRecord> {
  create(data: unknown, options?: ReadOptions): Promise<T>;
  findById(id: string, options?: ReadOptions): Promise<T | null>;
  findOne(where: Condition[], options?: ReadOptions): Promise<T | null>;
  list(query: ListQuery, options?: ReadOptions): Promise<ListResult<T>>;
  update(id: string, changes: unknown, options?: ReadOptions): Promise<T>;
  replace(id: string, data: unknown, options?: ReadOptions): Promise<T>;
  delete(id: string): Promise<void>;
}

export type RepositoryRegistry = Record<string, Repository>;

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

export function createRepository(model: EntityModel, adapter: DatabaseAdapter, models: EntityModel[] = [model]): Repository {
  const hiddenFields = model.fields.filter((field) => field.hidden).map((field) => field.name);

  const present = (record: StoredRecord, options: ReadOptions = {}): EntityRecord => {
    if (options.includeHidden || hiddenFields.length === 0) return record;
    const visible = { ...record };
    for (const name of hiddenFields) delete visible[name];
    return visible;
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

  return {
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
      return record ? present(record, options) : null;
    },

    async findOne(where, options) {
      const record = await adapter.findOne(model, where);
      return record ? present(record, options) : null;
    },

    async list(query, options) {
      const { data, total } = await adapter.findMany(model, query);
      return { data: data.map((record) => present(record, options)), total, limit: query.limit, offset: query.offset };
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
}

export function createRepositories(models: EntityModel[], adapter: DatabaseAdapter): RepositoryRegistry {
  return Object.fromEntries(models.map((model) => [model.repoKey, createRepository(model, adapter, models)]));
}
