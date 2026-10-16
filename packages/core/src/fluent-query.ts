import { SYSTEM_FIELDS, type EntityModel, type FieldModel } from "./model.ts";
import { project } from "./projection.ts";
import type { Condition, FilterOperator, ListQuery, SortField } from "./query.ts";

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

/** A field a query can be ordered by. */
export class SortKey {
  constructor(readonly field: string) {}
}

/** Fields a query can be ordered by: scalars and dates, not arrays or objects. */
export type SortFields<T> = {
  [K in keyof T as NonNullable<T[K]> extends Date ? K : NonNullable<T[K]> extends object ? never : K]-?: SortKey;
};

export type SortLambda<T> = (fields: SortFields<T>) => SortKey;

/** A LINQ-like query on one entity; each `where` narrows it, and a terminal method runs it. */
export interface Query<T> {
  where(lambda: QueryLambda<T>): Query<T>;
  /** Orders by a field, replacing earlier ordering. */
  orderBy(lambda: SortLambda<T>): Query<T>;
  orderByDescending(lambda: SortLambda<T>): Query<T>;
  /** Adds a further sort field. */
  thenBy(lambda: SortLambda<T>): Query<T>;
  thenByDescending(lambda: SortLambda<T>): Query<T>;
  /** Leaves out the first `count` results (not applied to `count()` and `any()`). */
  skip(count: number): Query<T>;
  /** Returns at most `count` results (not applied to `count()` and `any()`). */
  take(count: number): Query<T>;
  /** Returns only these fields plus `id`. */
  select<K extends keyof T & string>(...fields: K[]): Query<Pick<T, K | ("id" & keyof T)>>;
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

/** What a query needs from its repository. */
export interface QueryBackend {
  model: EntityModel;
  findAllMax: number;
  list(query: ListQuery): Promise<{ data: Record<string, unknown>[]; total: number }>;
  count(where: Condition[]): Promise<number>;
  notFound(): Error;
}

interface QueryState {
  where: Condition[];
  sort: SortField[];
  skip: number;
  take?: number;
  select?: string[];
}

const DEFAULT_SORT: SortField[] = [
  { field: "createdAt", direction: "desc" },
  { field: "id", direction: "desc" },
];

/** Sort keys for the fields the list routes can sort by; any other field throws when used. */
function sortKeys(model: EntityModel): Record<string, SortKey> {
  const sortable = new Set<string>([
    ...SYSTEM_FIELDS,
    ...model.fields
      .filter((field) => field.storage === "column" && !["array", "object", "refArray"].includes(field.type))
      .map((field) => field.name),
  ]);
  return new Proxy({} as Record<string, SortKey>, {
    get(_, name) {
      if (typeof name !== "string" || !sortable.has(name)) throw new Error(`${model.entityName} cannot be ordered by "${String(name)}"`);
      return new SortKey(name);
    },
  });
}

function nonNegative(method: string, count: number): number {
  if (!Number.isInteger(count) || count < 0) throw new Error(`${method} expects a non-negative integer, got ${count}`);
  return count;
}

/** A query over the backend's records with the given state; every method returns a new query. */
export function createQuery<T>(backend: QueryBackend, state: QueryState): Query<T> {
  const { model, findAllMax } = backend;
  const next = (changes: Partial<QueryState>) => createQuery<T>(backend, { ...state, ...changes });
  const keyOf = (lambda: SortLambda<T>) => {
    const key = lambda(sortKeys(model) as unknown as SortFields<T>);
    if (!(key instanceof SortKey)) throw new Error(`An order lambda on ${model.entityName} must return a field`);
    return key.field;
  };
  const sorted = (sort: SortField[]) => [...sort.filter((item) => item.field !== "id"), ...(sort.some((item) => item.field === "id") ? sort.filter((item) => item.field === "id") : [{ field: "id", direction: "desc" as const }])];
  const shape = (records: Record<string, unknown>[]) =>
    (state.select ? records.map((record) => project(record, { include: ["id", ...state.select!] })) : records) as T[];
  const read = async (limit: number, offset: number) => {
    const result = await backend.list({ where: state.where, sort: state.sort.length > 0 ? sorted(state.sort) : DEFAULT_SORT, limit, offset });
    return { ...result, data: shape(result.data) };
  };
  const count = () => backend.count(state.where);
  /** How many records the slice returns out of `total` matches. */
  const sliceSize = (total: number) => Math.max(0, Math.min(state.take ?? Number.POSITIVE_INFINITY, total - state.skip));
  return {
    where: (lambda) => next({ where: [...state.where, ...conditionsOf(model, lambda)] }),
    orderBy: (lambda) => next({ sort: [{ field: keyOf(lambda), direction: "asc" }] }),
    orderByDescending: (lambda) => next({ sort: [{ field: keyOf(lambda), direction: "desc" }] }),
    thenBy: (lambda) => next({ sort: [...state.sort, { field: keyOf(lambda), direction: "asc" }] }),
    thenByDescending: (lambda) => next({ sort: [...state.sort, { field: keyOf(lambda), direction: "desc" }] }),
    skip: (value) => next({ skip: nonNegative("skip", value) }),
    take: (value) => next({ take: nonNegative("take", value) }),
    select: (...fields) => createQuery(backend, { ...state, select: fields }) as never,
    async all() {
      const size = sliceSize(await count());
      if (size > findAllMax) {
        throw new Error(`Query on ${model.entityName} matched ${size} records, more than repositories.findAllMax (${findAllMax})`);
      }
      return size === 0 ? [] : (await read(size, state.skip)).data;
    },
    async first() {
      const record = state.take === 0 ? undefined : (await read(1, state.skip)).data[0];
      if (!record) throw backend.notFound();
      return record;
    },
    async firstOrDefault() {
      return state.take === 0 ? null : ((await read(1, state.skip)).data[0] ?? null);
    },
    count,
    async any() {
      return (await count()) > 0;
    },
    async page({ limit = 20, offset = 0 }: PageOptions = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error(`page limit must be an integer from 1 to 100, got ${limit}`);
      if (!Number.isInteger(offset) || offset < 0) throw new Error(`page offset must be a non-negative integer, got ${offset}`);
      const size = Math.min(limit, state.take === undefined ? limit : Math.max(0, state.take - offset));
      const result = size === 0 ? { data: [] as T[], total: await count() } : await read(size, state.skip + offset);
      return { data: result.data, total: result.total, limit, offset };
    },
  };
}
