import { AsyncLocalStorage } from "node:async_hooks";
import { MongoClient, type ClientSession, type Db, type Document, type Filter, type Sort } from "mongodb";
import { UniqueViolationError, type DatabaseAdapter, type StoredRecord } from "../adapter.ts";
import type { EntityModel, FieldModel } from "../model.ts";
import { schemaIdentifier } from "../sql/schema.ts";
import { isConditionGroup, type Condition, type FieldCondition, type SizeFilter, type SortField } from "../query.ts";

export interface MongodbAdapterOptions {
  url: string;
  database: string;
}

export interface MongodbAdapter extends DatabaseAdapter {
  readonly client: MongoClient | undefined;
  /** The default database: the resolved default schema's database, or the configured one. */
  readonly db: Db | undefined;
  /** The database of an explicit schema, or the default database. */
  databaseFor(schema?: string | null): Db;
  createIndexes(model: EntityModel): Promise<void>;
  dropIndexes(model: EntityModel): Promise<void>;
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\/]/g;

export function escapeRegex(value: string): string {
  return value.replace(REGEX_SPECIAL, "\\$&");
}

const fieldPath = (field: string) => (field === "id" ? "_id" : field);

function translate({ field, op, value }: FieldCondition): Document {
  const path = fieldPath(field);
  switch (op) {
    case "eq":
      return { [path]: { $eq: value } };
    case "ne":
      // Like SQL, comparisons never match missing values.
      return { $and: [{ [path]: { $ne: value } }, { [path]: { $ne: null } }] };
    case "in":
      return { [path]: { $in: value } };
    case "nin":
      return { $and: [{ [path]: { $nin: value } }, { [path]: { $ne: null } }] };
    case "gt":
      return { [path]: { $gt: value } };
    case "gte":
      return { [path]: { $gte: value } };
    case "lt":
      return { [path]: { $lt: value } };
    case "lte":
      return { [path]: { $lte: value } };
    case "contains":
      return { [path]: { $regex: escapeRegex(String(value)), $options: "i" } };
    case "startsWith":
      return { [path]: { $regex: `^${escapeRegex(String(value))}`, $options: "i" } };
    case "exists":
      return value ? { [path]: { $ne: null } } : { [path]: { $eq: null } };
    case "isNull":
      return value ? { [path]: { $eq: null } } : { [path]: { $ne: null } };
    default:
      throw new Error(`Operator ${op} only applies to reference arrays`);
  }
}

function translateArray({ field, op, value }: FieldCondition): Document {
  const length = { $size: { $ifNull: [`$${field}`, []] } };
  switch (op) {
    case "contains":
      return { [field]: value };
    case "containsAny":
      return { [field]: { $in: value } };
    case "containsAll":
      return { [field]: { $all: value } };
    case "size": {
      const { compare, count } = value as SizeFilter;
      return { $expr: { [`$${compare}`]: [length, count] } };
    }
    case "isEmpty":
      return { $expr: { [value ? "$eq" : "$gt"]: [length, 0] } };
    default:
      throw new Error(`Operator ${op} is not supported on reference arrays`);
  }
}

/** Translates list conditions (combined with AND) into a MongoDB filter. */
export function toFilter(conditions: Condition[], entity?: EntityModel): Filter<Document> {
  if (conditions.length === 0) return {};
  const isRelation = (condition: FieldCondition) =>
    entity?.fields.some((field) => field.name === condition.field && field.type === "refArray") ?? false;
  const one = (condition: Condition): Document => {
    if (isConditionGroup(condition)) {
      // An empty AND matches everything; an empty OR matches nothing.
      if (condition.conditions.length === 0) return condition.group === "or" ? { _id: { $in: [] } } : {};
      return { [condition.group === "or" ? "$or" : "$and"]: condition.conditions.map(one) };
    }
    return isRelation(condition) ? translateArray(condition) : translate(condition);
  };
  return { $and: conditions.map(one) };
}

export function toSort(sort: SortField[]): Sort {
  return Object.fromEntries(sort.map(({ field, direction }) => [fieldPath(field), direction === "asc" ? 1 : -1]));
}

function toDocument(entity: EntityModel, record: StoredRecord): Document {
  const { id, ...rest } = record;
  const document: Document = { _id: id, ...rest };
  for (const field of entity.fields) {
    if (document[field.name] === undefined || (field.type === "refArray" && document[field.name] === null)) {
      document[field.name] = field.type === "refArray" ? [] : null;
    }
  }
  return document;
}

function toRecord(entity: EntityModel, document: Document | null): StoredRecord | null {
  if (!document) return null;
  const { _id, ...rest } = document;
  const record = { id: _id, ...rest } as StoredRecord;
  for (const field of entity.fields) {
    if (record[field.name] === undefined) record[field.name] = field.type === "refArray" ? [] : null;
  }
  return record;
}

const BSON_TYPES: Record<FieldModel["type"], string> = {
  string: "string",
  enum: "string",
  ref: "string",
  number: "number",
  boolean: "bool",
  date: "date",
  array: "array",
  refArray: "array",
  object: "object",
  json: "object",
};

export interface MongoIndexSpec {
  /** Explicit schema of the entity (its own database), or null for the default database. */
  schema: string | null;
  collection: string;
  name: string;
  keys: Record<string, 1>;
  options: { unique?: true; partialFilterExpression?: Document };
}

/**
 * The indexes an entity needs: createdAt, plus one per `@unique` (partial on non-null values) and `@index` field, and
 * the entity's indexes over several fields.
 */
export function mongoIndexSpecs(model: EntityModel): MongoIndexSpec[] {
  const collection = model.tableName;
  const schema = model.schema;
  const specs: MongoIndexSpec[] = [{ schema, collection, name: `${collection}_created_at_idx`, keys: { createdAt: 1 }, options: {} }];
  for (const field of model.fields) {
    if (field.unique) {
      specs.push({
        schema,
        collection,
        name: `${collection}_${field.name}_uq`,
        keys: { [field.name]: 1 },
        options: { unique: true, partialFilterExpression: { [field.name]: { $type: BSON_TYPES[field.type] } } },
      });
    }
    // Reference arrays get a multikey index so lookups by referenced id stay fast.
    if (field.storage === "derived") continue;
    if (field.index || field.type === "refArray") {
      specs.push({ schema, collection, name: `${collection}_${field.name}_idx`, keys: { [field.name]: 1 }, options: {} });
    }
  }
  for (const { fields, unique } of model.indexes ?? []) {
    specs.push({
      schema,
      collection,
      name: `${collection}_${fields.join("_")}_${unique ? "uq" : "idx"}`,
      keys: Object.fromEntries(fields.map((field) => [field, 1 as const])),
      options: unique ? { unique: true } : {},
    });
  }
  return specs;
}

/** Field name of a duplicate key error (code 11000), when it is one. */
export function duplicateKeyField(error: unknown): string | undefined {
  const candidate = error as { code?: number; keyPattern?: Record<string, unknown>; message?: string } | undefined;
  if (candidate?.code !== 11000) return undefined;
  const [field] = Object.keys(candidate.keyPattern ?? {});
  return field ?? /index: \w+_(\w+)_uq/.exec(candidate.message ?? "")?.[1] ?? "unknown";
}

export function mongodbAdapter(options: MongodbAdapterOptions): MongodbAdapter {
  let client: MongoClient | undefined;
  let db: Db | undefined;
  let supportsTransactions = false;
  const sessions = new AsyncLocalStorage<ClientSession>();

  const databaseFor = (schema?: string | null): Db => {
    if (!client || !db) throw new Error("The MongoDB adapter is not connected");
    return schema ? client.db(schemaIdentifier(schema)) : db;
  };
  const collection = (entity: EntityModel) => databaseFor(entity.schema).collection(entity.tableName);
  const session = () => {
    const current = sessions.getStore();
    return current ? { session: current } : {};
  };
  const translateErrors = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      const field = duplicateKeyField(error);
      if (field) throw new UniqueViolationError(field);
      throw error;
    }
  };

  return {
    kind: "mongodb",
    get client() {
      return client;
    },
    get db() {
      return db;
    },
    databaseFor,
    async connect(_, connectOptions = {}) {
      client = new MongoClient(options.url);
      await client.connect();
      db = client.db(connectOptions.defaultSchema ? schemaIdentifier(connectOptions.defaultSchema) : options.database);
      const hello = await db.admin().command({ hello: 1 });
      supportsTransactions = Boolean(hello.setName) || hello.msg === "isdbgrid";
    },
    async disconnect() {
      await client?.close();
      client = undefined;
      db = undefined;
    },
    async createIndexes(model) {
      const target = collection(model);
      for (const spec of mongoIndexSpecs(model)) await target.createIndex(spec.keys, { name: spec.name, ...spec.options });
    },
    async dropIndexes(model) {
      const target = collection(model);
      const indexes = await target.indexes().catch(() => []);
      for (const index of indexes) {
        if (index.name && index.name !== "_id_") await target.dropIndex(index.name);
      }
    },
    insert(entity, record) {
      return translateErrors(async () => {
        await collection(entity).insertOne(toDocument(entity, record), session());
        return toRecord(entity, await collection(entity).findOne({ _id: record.id as never }, session()))!;
      });
    },
    async findById(entity, id) {
      return toRecord(entity, await collection(entity).findOne({ _id: id as never }, session()));
    },
    async findOne(entity, where) {
      return toRecord(entity, await collection(entity).findOne(toFilter(where, entity), session()));
    },
    async findMany(entity, { where, sort, limit, offset }) {
      const filter = toFilter(where, entity);
      const documents = await collection(entity).find(filter, session()).sort(toSort(sort)).skip(offset).limit(limit).toArray();
      const total = await collection(entity).countDocuments(filter, session());
      return { data: documents.map((document) => toRecord(entity, document)!), total };
    },
    updateById(entity, id, changes, where = []) {
      return translateErrors(async () => {
        const filter = where.length > 0 ? { $and: [{ _id: id as never }, toFilter(where, entity)] } : { _id: id as never };
        const result = await collection(entity).updateOne(filter, { $set: changes }, session());
        return result.matchedCount > 0;
      });
    },
    async deleteById(entity, id) {
      return (await collection(entity).deleteOne({ _id: id as never }, session())).deletedCount > 0;
    },
    async count(entity, where) {
      return collection(entity).countDocuments(toFilter(where, entity), session());
    },
    async transaction(fn) {
      if (sessions.getStore() || !supportsTransactions || !client) return fn();
      const current = client.startSession();
      try {
        current.startTransaction();
        const result = await sessions.run(current, fn);
        await current.commitTransaction();
        return result;
      } catch (error) {
        if (current.inTransaction()) await current.abortTransaction();
        throw error;
      } finally {
        await current.endSession();
      }
    },
  };
}
