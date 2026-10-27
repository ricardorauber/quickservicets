import {
  invalidConnection,
  UniqueViolationError,
  type Aggregate,
  type AggregateValues,
  type DatabaseAdapter,
  type FindManyOptions,
  type FindManyResult,
  type RelatedScope,
  type StoredRecord,
} from "../adapter.ts";
import type { EntityModel } from "../model.ts";
import { TransactionScope } from "../sql/transaction-scope.ts";
import type { Condition, SortField } from "../query.ts";
import { compareValues, matches } from "../matching.ts";
import { placedView, schemaViews } from "./schema-views.ts";

type Table = Map<string, StoredRecord>;

const isNullish = (value: unknown): boolean => value === null || value === undefined;

function sortRecords(records: StoredRecord[], sort: SortField[]): StoredRecord[] {
  return records.sort((left, right) => {
    for (const { field, direction } of sort) {
      const a = left[field];
      const b = right[field];
      let result: number;
      // Nulls sort last ascending and first descending, as in PostgreSQL.
      if (isNullish(a) || isNullish(b)) result = isNullish(a) === isNullish(b) ? 0 : isNullish(a) ? 1 : -1;
      else result = compareValues(a, b);
      if (result !== 0) return direction === "asc" ? result : -result;
    }
    return 0;
  });
}

/** Computes one aggregate like SQL does: null values are skipped, and only counts are 0 without values. */
function aggregateOf(records: StoredRecord[], aggregate: Aggregate, entity: EntityModel): number | Date | null {
  if (aggregate.fn === "count") {
    const where = aggregate.where ?? [];
    return records.filter((record) => where.every((condition) => matches(record, condition, entity))).length;
  }
  const values = records.map((record) => record[aggregate.field]).filter((value) => !isNullish(value));
  if (values.length === 0) return null;
  if (aggregate.fn === "sum" || aggregate.fn === "avg") {
    const sum = (values as number[]).reduce((total, value) => total + value, 0);
    return aggregate.fn === "sum" ? sum : sum / values.length;
  }
  const pick = values.reduce((best, value) => ((aggregate.fn === "min" ? compareValues(value, best) < 0 : compareValues(value, best) > 0) ? value : best));
  return pick instanceof Date ? new Date(pick) : (pick as number);
}

/** The record without the omitted fields. */
function without(record: StoredRecord, omit: readonly string[] | undefined): StoredRecord {
  for (const field of omit ?? []) delete record[field];
  return record;
}

/** The stores of `forConnection`, one per connection text, kept across opening and closing. */
const connectionStores = new Map<string, DatabaseAdapter>();

export function memoryAdapter(): DatabaseAdapter {
  const tables = new Map<string, Table>();
  // Transactions run one at a time, like on SQLite; the undo log of the running one restores what it changed.
  const scope = new TransactionScope();
  let undo: (() => void)[] | undefined;
  /** Records how to restore the record `id` of `table` as it is now, when a transaction runs. */
  const remember = (table: Table, id: string) => {
    if (!undo) return;
    const previous = table.get(id);
    undo.push(() => (previous === undefined ? table.delete(id) : table.set(id, previous)));
  };

  // Each schema is its own namespace, so `users` and `auth/users` never share records.
  const tableFor = (entity: EntityModel): Table => {
    const key = `${entity.schema ?? ""}\u0000${entity.tableName}`;
    let table = tables.get(key);
    if (!table) {
      table = new Map();
      tables.set(key, table);
    }
    return table;
  };

  const select = (entity: EntityModel, where: Condition[]): StoredRecord[] =>
    [...tableFor(entity).values()].filter((record) => where.every((condition) => matches(record, condition, entity)));

  /** One page of `records`, in `sort` order. */
  const page = (records: StoredRecord[], { sort, limit, offset, withTotal = true, omit }: FindManyOptions): FindManyResult => {
    const sorted = sortRecords(records, sort);
    const data = sorted.slice(offset, offset + limit).map((record) => without(structuredClone(record), omit));
    return { data, total: withTotal ? sorted.length : data.length };
  };

  const aggregateAll = (entity: EntityModel, records: StoredRecord[], aggregates: Record<string, Aggregate>): AggregateValues => {
    const values: AggregateValues = {};
    for (const [name, aggregate] of Object.entries(aggregates)) values[name] = aggregateOf(records, aggregate, entity);
    return values;
  };

  /** The related records of `scope` matching `where`, or null when the owner does not exist. */
  const selectRelated = ({ owner, id, field, target }: RelatedScope, where: Condition[]): StoredRecord[] | null => {
    const record = tableFor(owner).get(id);
    if (!record) return null;
    const records = tableFor(target);
    const ids = new Set((record[field] as string[] | null) ?? []);
    return [...ids].flatMap((targetId) => {
      const found = records.get(targetId);
      return found && where.every((condition) => matches(found, condition, target)) ? [found] : [];
    });
  };

  const assertUnique = (entity: EntityModel, record: StoredRecord): void => {
    for (const field of entity.fields) {
      if (!field.unique || isNullish(record[field.name])) continue;
      for (const other of tableFor(entity).values()) {
        if (other.id !== record.id && compareValues(other[field.name], record[field.name]) === 0) {
          throw new UniqueViolationError(field.name);
        }
      }
    }
    for (const { fields, unique } of entity.indexes ?? []) {
      if (!unique) continue;
      for (const other of tableFor(entity).values()) {
        if (other.id !== record.id && fields.every((field) => compareValues(other[field], record[field]) === 0)) {
          throw new UniqueViolationError(fields[0]!);
        }
      }
    }
  };

  const normalize = (entity: EntityModel, record: StoredRecord): StoredRecord => {
    const normalized: StoredRecord = { ...record };
    for (const field of entity.fields) {
      if (normalized[field.name] === undefined || (field.type === "refArray" && normalized[field.name] === null)) {
        normalized[field.name] = field.type === "refArray" ? [] : null;
      }
    }
    return structuredClone(normalized);
  };

  const views = schemaViews(() => adapter, (schema) => placedView(adapter, schema));
  const adapter: DatabaseAdapter = {
    kind: "memory",
    supportsRollback: true,
    withSchema: (schema) => views.get(schema),
    forConnection(connection) {
      if (typeof connection !== "string" || connection === "") throw invalidConnection("memory", "expected a text");
      let store = connectionStores.get(connection);
      if (!store) {
        store = memoryAdapter();
        connectionStores.set(connection, store);
      }
      // A tenant store keeps its records while its pool closes and opens again, like a real database.
      return { ...store, disconnect: async () => {} };
    },
    sharesConnectionWith: (other) => other === adapter || views.owns(other),
    async connect(models) {
      for (const model of models) tableFor(model);
    },
    async disconnect() {
      tables.clear();
    },
    insert(entity, record) {
      return scope.run(() => {
        const stored = normalize(entity, record);
        assertUnique(entity, stored);
        remember(tableFor(entity), stored.id);
        tableFor(entity).set(stored.id, stored);
        return structuredClone(stored);
      });
    },
    insertOrSkip(entity, record, unique) {
      return scope.run(() => {
        const stored = normalize(entity, record);
        const value = stored[unique];
        if (value !== null && value !== undefined && [...tableFor(entity).values()].some((existing) => existing[unique] === value)) return null;
        assertUnique(entity, stored);
        remember(tableFor(entity), stored.id);
        tableFor(entity).set(stored.id, stored);
        return structuredClone(stored);
      });
    },
    findById(entity, id, options) {
      return scope.run(() => {
        const record = tableFor(entity).get(id);
        return record ? without(structuredClone(record), options?.omit) : null;
      });
    },
    findOne(entity, where) {
      return scope.run(() => {
        const [record] = select(entity, where);
        return record ? structuredClone(record) : null;
      });
    },
    findMany(entity, options: FindManyOptions) {
      return scope.run(() => page(select(entity, options.where), options));
    },
    findRelated(related, options) {
      return scope.run(() => page(selectRelated(related, options.where) ?? [], options));
    },
    countRelated(related, where) {
      return scope.run(() => selectRelated(related, where)?.length ?? 0);
    },
    aggregateRelated(related, where, aggregates) {
      return scope.run(() => {
        const records = selectRelated(related, where);
        return records ? aggregateAll(related.target, records, aggregates) : null;
      });
    },
    updateById(entity, id, changes, where = []) {
      return scope.run(() => {
        const table = tableFor(entity);
        const current = table.get(id);
        if (!current || !where.every((condition) => matches(current, condition, entity))) return null;
        const updated = normalize(entity, { ...current, ...changes, id });
        assertUnique(entity, updated);
        remember(table, id);
        table.set(id, updated);
        return structuredClone(updated);
      });
    },
    increment(entity, id, amounts, insert) {
      return scope.run(() => {
        const table = tableFor(entity);
        const current = table.get(id);
        const added = current ? Object.fromEntries(Object.entries(amounts).map(([field, amount]) => [field, Number(current[field] ?? 0) + amount])) : amounts;
        const next = normalize(entity, { ...(current ?? insert), ...added, id });
        if (!current) assertUnique(entity, next);
        remember(table, id);
        table.set(id, next);
        return structuredClone(next);
      });
    },
    deleteById(entity, id) {
      return scope.run(() => {
        remember(tableFor(entity), id);
        return tableFor(entity).delete(id);
      });
    },
    count(entity, where) {
      return scope.run(() => select(entity, where).length);
    },
    aggregate(entity, where, aggregates) {
      return scope.run(() => aggregateAll(entity, select(entity, where), aggregates));
    },
    async ping() {},
    transaction(fn) {
      return scope.transaction(fn, {
        begin: () => {
          undo = [];
        },
        commit: () => {
          undo = undefined;
        },
        rollback: () => {
          for (const restore of (undo ?? []).reverse()) restore();
          undo = undefined;
        },
      });
    },
  };
  return adapter;
}
