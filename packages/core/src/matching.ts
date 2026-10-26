import type { StoredRecord } from "./adapter.ts";
import type { EntityModel } from "./model.ts";
import { isConditionGroup, type Condition, type FieldCondition, type SizeFilter } from "./query.ts";

const comparable = (value: unknown): unknown => (value instanceof Date ? value.getTime() : value);

/** A date and a date text compare as instants, as the databases compare them. */
const instant = (value: unknown): unknown => (typeof value === "string" ? new Date(value).getTime() : comparable(value));

const isNullish = (value: unknown): boolean => value === null || value === undefined;

export function compareValues(left: unknown, right: unknown): number {
  const dates = left instanceof Date || right instanceof Date;
  const a = dates ? instant(left) : comparable(left);
  const b = dates ? instant(right) : comparable(right);
  if (a === b) return 0;
  return (a as number | string) < (b as number | string) ? -1 : 1;
}

export function matches(record: StoredRecord, condition: Condition, entity: EntityModel): boolean {
  if (isConditionGroup(condition)) {
    const test = (inner: Condition) => matches(record, inner, entity);
    if (condition.group === "or") return condition.conditions.some(test);
    // Comparisons with a missing value are false, so their negation matches it.
    return condition.group === "not" ? !condition.conditions.every(test) : condition.conditions.every(test);
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

/**
 * Whether a record matches every condition, with the semantics of the adapters: case-insensitive `contains` and
 * `startsWith`, `in`, `exists`, `isNull`, reference arrays, and dates compared as instants. The memory adapter filters
 * with it, and features match records outside the database with it, like the change streams.
 */
export function matchesConditions(record: StoredRecord | Record<string, unknown>, where: readonly Condition[], entity: EntityModel): boolean {
  return where.every((condition) => matches(record as StoredRecord, condition, entity));
}
