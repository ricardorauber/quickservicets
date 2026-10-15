import { AsyncLocalStorage } from "node:async_hooks";
import { MongoClient, type ClientSession, type Db, type Document, type Filter, type Sort } from "mongodb";
import { UniqueViolationError, type DatabaseAdapter, type StoredRecord } from "../adapter.ts";
import type { EntityModel, FieldModel } from "../model.ts";
import type { Condition, SortField } from "../query.ts";

export interface MongodbAdapterOptions {
  url: string;
  database: string;
}

export interface MongodbAdapter extends DatabaseAdapter {
  readonly client: MongoClient | undefined;
  readonly db: Db | undefined;
  createIndexes(model: EntityModel): Promise<void>;
  dropIndexes(model: EntityModel): Promise<void>;
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\/]/g;

export function escapeRegex(value: string): string {
  return value.replace(REGEX_SPECIAL, "\\$&");
}

const fieldPath = (field: string) => (field === "id" ? "_id" : field);

function translate({ field, op, value }: Condition): Document {
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
  }
}

/** Translates list conditions (combined with AND) into a MongoDB filter. */
export function toFilter(conditions: Condition[]): Filter<Document> {
  if (conditions.length === 0) return {};
  return { $and: conditions.map(translate) };
}

export function toSort(sort: SortField[]): Sort {
  return Object.fromEntries(sort.map(({ field, direction }) => [fieldPath(field), direction === "asc" ? 1 : -1]));
}

function toDocument(entity: EntityModel, record: StoredRecord): Document {
  const { id, ...rest } = record;
  const document: Document = { _id: id, ...rest };
  for (const field of entity.fields) {
    if (document[field.name] === undefined) document[field.name] = null;
  }
  return document;
}

function toRecord(entity: EntityModel, document: Document | null): StoredRecord | null {
  if (!document) return null;
  const { _id, ...rest } = document;
  const record = { id: _id, ...rest } as StoredRecord;
  for (const field of entity.fields) {
    if (record[field.name] === undefined) record[field.name] = null;
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
  object: "object",
};

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

  const collection = (entity: EntityModel) => {
    if (!db) throw new Error("The MongoDB adapter is not connected");
    return db.collection(entity.tableName);
  };
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
    get client() {
      return client;
    },
    get db() {
      return db;
    },
    async connect() {
      client = new MongoClient(options.url);
      await client.connect();
      db = client.db(options.database);
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
      await target.createIndex({ createdAt: 1 }, { name: `${model.tableName}_created_at_idx` });
      for (const field of model.fields) {
        if (field.unique) {
          await target.createIndex(
            { [field.name]: 1 },
            {
              name: `${model.tableName}_${field.name}_uq`,
              unique: true,
              partialFilterExpression: { [field.name]: { $type: BSON_TYPES[field.type] } },
            },
          );
        }
        if (field.index) await target.createIndex({ [field.name]: 1 }, { name: `${model.tableName}_${field.name}_idx` });
      }
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
      return toRecord(entity, await collection(entity).findOne(toFilter(where), session()));
    },
    async findMany(entity, { where, sort, limit, offset }) {
      const filter = toFilter(where);
      const documents = await collection(entity).find(filter, session()).sort(toSort(sort)).skip(offset).limit(limit).toArray();
      const total = await collection(entity).countDocuments(filter, session());
      return { data: documents.map((document) => toRecord(entity, document)!), total };
    },
    updateById(entity, id, changes) {
      return translateErrors(async () => {
        const result = await collection(entity).updateOne({ _id: id as never }, { $set: changes }, session());
        return result.matchedCount > 0;
      });
    },
    async deleteById(entity, id) {
      return (await collection(entity).deleteOne({ _id: id as never }, session())).deletedCount > 0;
    },
    async count(entity, where) {
      return collection(entity).countDocuments(toFilter(where), session());
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
