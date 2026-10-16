import { SYSTEM_FIELDS, type EntityModel, type FieldModel } from "./model.ts";
import type { Condition, FilterOperator } from "./query.ts";

/** One or more conditions combined with AND, built by the field handles of a query lambda. */
export class QueryCondition {
  constructor(readonly conditions: readonly Condition[]) {}

  /** Both this condition and `other`. */
  and(other: QueryCondition): QueryCondition {
    return new QueryCondition([...this.conditions, ...other.conditions]);
  }
}

interface ScalarHandle<V> {
  eq(value: V): QueryCondition;
  ne(value: V): QueryCondition;
  in(values: readonly V[]): QueryCondition;
  nin(values: readonly V[]): QueryCondition;
  exists(value?: boolean): QueryCondition;
  isNull(value?: boolean): QueryCondition;
}

interface OrderedHandle<V> extends ScalarHandle<V> {
  gt(value: V): QueryCondition;
  gte(value: V): QueryCondition;
  lt(value: V): QueryCondition;
  lte(value: V): QueryCondition;
}

interface StringHandle<V extends string> extends ScalarHandle<V> {
  /** Case-insensitive, literal substring match. */
  contains(value: string): QueryCondition;
  /** Case-insensitive, literal prefix match. */
  startsWith(value: string): QueryCondition;
}

interface ReferenceArrayHandle {
  contains(id: string): QueryCondition;
  containsAny(ids: readonly string[]): QueryCondition;
  containsAll(ids: readonly string[]): QueryCondition;
  isEmpty(value?: boolean): QueryCondition;
}

type HandleOf<V> = [V] extends [Date]
  ? OrderedHandle<Date>
  : [V] extends [number]
    ? OrderedHandle<number>
    : [V] extends [boolean]
      ? ScalarHandle<boolean>
      : [V] extends [string]
        ? string extends V
          ? StringHandle<string>
          : ScalarHandle<V>
        : [V] extends [readonly string[]]
          ? ReferenceArrayHandle
          : never;

/** The typed field handles a query lambda receives: one per filterable field of the record type. */
export type QueryFields<T> = {
  [K in keyof T as HandleOf<NonNullable<T[K]>> extends never ? never : K]-?: HandleOf<NonNullable<T[K]>>;
};

export type QueryLambda<T> = (fields: QueryFields<T>) => QueryCondition;

const SCALAR_OPERATORS: FilterOperator[] = ["eq", "ne", "in", "nin", "exists", "isNull"];

/** Operators a field accepts, matching the HTTP filters; empty when the field cannot be filtered. */
function operatorsOf(field: Pick<FieldModel, "type"> | undefined): FilterOperator[] {
  switch (field?.type) {
    case "number":
    case "date":
      return [...SCALAR_OPERATORS, "gt", "gte", "lt", "lte"];
    case "string":
      return [...SCALAR_OPERATORS, "contains", "startsWith"];
    case "boolean":
    case "enum":
    case "ref":
      return SCALAR_OPERATORS;
    case "refArray":
      return ["contains", "containsAny", "containsAll", "isEmpty"];
    default:
      return [];
  }
}

const SYSTEM_TYPES: Record<string, Pick<FieldModel, "type">> = { id: { type: "string" }, createdAt: { type: "date" }, updatedAt: { type: "date" } };

/** Builds the handles for an entity; using an operator a field does not accept throws a descriptive error. */
function fieldHandles(model: EntityModel): Record<string, Record<string, (value?: unknown) => QueryCondition>> {
  const fields: [string, Pick<FieldModel, "type">][] = [
    ...SYSTEM_FIELDS.map((name) => [name, SYSTEM_TYPES[name]!] as [string, Pick<FieldModel, "type">]),
    // Computed fields (file URLs) are not stored, so they cannot be filtered.
    ...model.fields.filter((field) => field.storage !== "computed").map((field) => [field.name, field] as [string, Pick<FieldModel, "type">]),
  ];
  const handles: Record<string, Record<string, (value?: unknown) => QueryCondition>> = {};
  for (const [name, field] of fields) {
    const operators = operatorsOf(field);
    if (operators.length === 0) continue;
    const handle: Record<string, (value?: unknown) => QueryCondition> = {};
    for (const op of ["eq", "ne", "in", "nin", "gt", "gte", "lt", "lte", "contains", "startsWith", "exists", "isNull", "containsAny", "containsAll", "isEmpty"] as const) {
      handle[op] = (value?: unknown) => {
        if (!operators.includes(op)) throw new Error(`Operator "${op}" is not allowed on ${model.entityName}.${name}`);
        const condition: Condition = { field: name, op, value: value === undefined && ["exists", "isNull", "isEmpty"].includes(op) ? true : value };
        // Text matching follows the HTTP filters: case-insensitive and literal.
        if ((op === "contains" || op === "startsWith") && field.type === "string") {
          return new QueryCondition([{ ...condition, caseInsensitive: true, literal: true }]);
        }
        return new QueryCondition([condition]);
      };
    }
    handles[name] = handle;
  }
  return handles;
}

/** Runs a query lambda against an entity's handles and returns its conditions. */
export function conditionsOf<T>(model: EntityModel, lambda: QueryLambda<T>): Condition[] {
  const result = lambda(fieldHandles(model) as unknown as QueryFields<T>);
  if (!(result instanceof QueryCondition)) throw new Error(`A query lambda on ${model.entityName} must return a condition`);
  return [...result.conditions];
}

export interface PageOptions {
  /** 1–100, default 20. */
  limit?: number;
  /** 0 or more, default 0. */
  offset?: number;
}

/** A LINQ-like query on one entity; each `where` narrows it, and a terminal method runs it. */
export interface Query<T> {
  where(lambda: QueryLambda<T>): Query<T>;
  /** Every match; throws when there are more than `repositories.findAllMax`. */
  all(): Promise<T[]>;
  /** The first match, or 404 `<Entity> not found`. */
  first(): Promise<T>;
  /** The first match, or null. */
  firstOrDefault(): Promise<T | null>;
  count(): Promise<number>;
  any(): Promise<boolean>;
  /** `{ data, total, limit, offset }` like the generated list routes. */
  page(options?: PageOptions): Promise<{ data: T[]; total: number; limit: number; offset: number }>;
}
