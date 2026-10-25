import {
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
import { isConditionGroup, type Condition, type FieldCondition, type SizeFilter, type SortField } from "../query.ts";

type Table = Map<string, StoredRecord>;

const comparable = (value: unknown): unknown => (value instanceof Date ? value.getTime() : value);

const isNullish = (value: unknown): boolean => value === null || value === undefined;

function compareValues(left: unknown, right: unknown): number {
  const a = comparable(left);
  const b = comparable(right);
  if (a === b) return 0;
  return (a as number | string) < (b as number | string) ? -1 : 1;
}

function matches(record: StoredRecord, condition: Condition, entity: EntityModel): boolean {
  if (isConditionGroup(condition)) {
    const test = (inner: Condition) => matches(record, inner, entity);
    return condition.group === "or" ? condition.conditions.some(test) : condition.conditions.every(test);
  }
  const actual = record[condition.field];
  const { op, value } = condition;
  if (entity.fields.some((field) => field.name === condition.field && field.type === "refArray")) {
    return matchesArray(Array.isArray(actual) ? (actual as string[]) : [], condition);
  }
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
    default:
      throw new Error(`Operator ${op} only applies to reference arrays`);
  }
}

export function compareSize(length: number, { compare, count }: SizeFilter): boolean {
  switch (compare) {
    case "eq":
      return length === count;
    case "ne":
      return length !== count;
    case "gt":
      return length > count;
    case "gte":
      return length >= count;
    case "lt":
      return length < count;
    case "lte":
      return length <= count;
  }
}

function matchesArray(ids: string[], { op, value }: FieldCondition): boolean {
  switch (op) {
    case "contains":
      return ids.includes(value as string);
    case "containsAny":
      return (value as string[]).some((id) => ids.includes(id));
    case "containsAll":
      return (value as string[]).every((id) => ids.includes(id));
    case "size":
      return compareSize(ids.length, value as SizeFilter);
    case "isEmpty":
      return (ids.length === 0) === value;
    default:
      throw new Error(`Operator ${op} is not supported on reference arrays`);
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

  return {
    kind: "memory",
    supportsRollback: true,
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
}
