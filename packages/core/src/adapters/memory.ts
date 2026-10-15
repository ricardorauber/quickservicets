import { UniqueViolationError, type DatabaseAdapter, type FindManyOptions, type StoredRecord } from "../adapter.ts";
import type { EntityModel } from "../model.ts";
import type { Condition, SortField } from "../query.ts";

type Table = Map<string, StoredRecord>;

const comparable = (value: unknown): unknown => (value instanceof Date ? value.getTime() : value);

const isNullish = (value: unknown): boolean => value === null || value === undefined;

function compareValues(left: unknown, right: unknown): number {
  const a = comparable(left);
  const b = comparable(right);
  if (a === b) return 0;
  return (a as number | string) < (b as number | string) ? -1 : 1;
}

function matches(record: StoredRecord, condition: Condition): boolean {
  const actual = record[condition.field];
  const { op, value } = condition;
  if (op === "exists") return isNullish(actual) !== value;
  if (op === "isNull") return isNullish(actual) === value;
  // Like SQL, comparisons against a missing value never match.
  if (isNullish(actual)) return false;
  switch (op) {
    case "eq":
      return compareValues(actual, value) === 0;
    case "ne":
      return compareValues(actual, value) !== 0;
    case "in":
      return (value as unknown[]).some((item) => compareValues(actual, item) === 0);
    case "nin":
      return (value as unknown[]).every((item) => compareValues(actual, item) !== 0);
    case "gt":
      return compareValues(actual, value) > 0;
    case "gte":
      return compareValues(actual, value) >= 0;
    case "lt":
      return compareValues(actual, value) < 0;
    case "lte":
      return compareValues(actual, value) <= 0;
    case "contains":
      return String(actual).toLowerCase().includes(String(value).toLowerCase());
    case "startsWith":
      return String(actual).toLowerCase().startsWith(String(value).toLowerCase());
  }
}

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

export function memoryAdapter(): DatabaseAdapter {
  const tables = new Map<string, Table>();

  const tableFor = (entity: EntityModel): Table => {
    let table = tables.get(entity.tableName);
    if (!table) {
      table = new Map();
      tables.set(entity.tableName, table);
    }
    return table;
  };

  const select = (entity: EntityModel, where: Condition[]): StoredRecord[] =>
    [...tableFor(entity).values()].filter((record) => where.every((condition) => matches(record, condition)));

  const assertUnique = (entity: EntityModel, record: StoredRecord): void => {
    for (const field of entity.fields) {
      if (!field.unique || isNullish(record[field.name])) continue;
      for (const other of tableFor(entity).values()) {
        if (other.id !== record.id && compareValues(other[field.name], record[field.name]) === 0) {
          throw new UniqueViolationError(field.name);
        }
      }
    }
  };

  const normalize = (entity: EntityModel, record: StoredRecord): StoredRecord => {
    const normalized: StoredRecord = { ...record };
    for (const field of entity.fields) {
      if (normalized[field.name] === undefined) normalized[field.name] = null;
    }
    return structuredClone(normalized);
  };

  return {
    kind: "memory",
    async connect(models) {
      for (const model of models) tableFor(model);
    },
    async disconnect() {
      tables.clear();
    },
    async insert(entity, record) {
      const stored = normalize(entity, record);
      assertUnique(entity, stored);
      tableFor(entity).set(stored.id, stored);
      return structuredClone(stored);
    },
    async findById(entity, id) {
      const record = tableFor(entity).get(id);
      return record ? structuredClone(record) : null;
    },
    async findOne(entity, where) {
      const [record] = select(entity, where);
      return record ? structuredClone(record) : null;
    },
    async findMany(entity, { where, sort, limit, offset }: FindManyOptions) {
      const records = sortRecords(select(entity, where), sort);
      return { data: records.slice(offset, offset + limit).map((record) => structuredClone(record)), total: records.length };
    },
    async updateById(entity, id, changes) {
      const table = tableFor(entity);
      const current = table.get(id);
      if (!current) return false;
      const updated = normalize(entity, { ...current, ...changes, id });
      assertUnique(entity, updated);
      table.set(id, updated);
      return true;
    },
    async deleteById(entity, id) {
      return tableFor(entity).delete(id);
    },
    async count(entity, where) {
      return select(entity, where).length;
    },
    async transaction(fn) {
      return fn();
    },
  };
}
