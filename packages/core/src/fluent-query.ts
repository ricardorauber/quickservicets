import type { Aggregate, AggregateValues } from "./adapter.ts";
import { HttpError, type FieldErrorDetail } from "./errors.ts";
import { SYSTEM_FIELDS, type EntityModel, type FieldModel } from "./model.ts";
import { project } from "./projection.ts";
import { MAX_LIMIT, type Condition, type FilterOperator, type ListQuery, type SortField } from "./query.ts";
import type { PopulatePath, Populated } from "./repository.ts";

/** One or more conditions combined with AND, built by the field handles of a query lambda. */
export class QueryCondition {
  constructor(readonly conditions: readonly Condition[]) {}

  /** Both this condition and `other`: `a.and(b.or(c))` is `a AND (b OR c)`. */
  and(other: QueryCondition): QueryCondition {
    return new QueryCondition([...this.conditions, ...other.conditions]);
  }

  /** This condition or `other`: `a.or(b).and(c)` is `(a OR b) AND c`. */
  or(other: QueryCondition): QueryCondition {
    return new QueryCondition([{ group: "or", conditions: [this.single(), other.single()] }]);
  }

  /** The conditions as one: itself when there is one, an AND group otherwise. */
  private single(): Condition {
    return this.conditions.length === 1 ? this.conditions[0]! : { group: "and", conditions: [...this.conditions] };
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

/** One aggregate of a query, built in an `aggregate` lambda; `V` is the type of its result. */
export class AggregateExpression<V> {
  /** The type of the result, for inference only. */
  declare readonly resultType: V;

  constructor(readonly aggregate: Aggregate) {}
}

interface NumberAggregates {
  /** The sum of the values, or null when no match has one. */
  sum(): AggregateExpression<number | null>;
  /** The average of the values, or null when no match has one. */
  avg(): AggregateExpression<number | null>;
  /** The smallest value, or null when no match has one. */
  min(): AggregateExpression<number | null>;
  /** The largest value, or null when no match has one. */
  max(): AggregateExpression<number | null>;
}

interface DateAggregates {
  /** The earliest value, or null when no match has one. */
  min(): AggregateExpression<Date | null>;
  /** The latest value, or null when no match has one. */
  max(): AggregateExpression<Date | null>;
}

type AggregateHandleOf<V> = [V] extends [Date]
  ? OrderedHandle<Date> & DateAggregates
  : [V] extends [number]
    ? OrderedHandle<number> & NumberAggregates
    : HandleOf<V>;

/**
 * What an `aggregate` lambda receives: the query's field handles, with `sum`, `avg`, `min` and `max` on numbers and
 * `min` and `max` on dates, plus `count(condition?)`.
 */
export type AggregateFields<T> = {
  [K in keyof T as HandleOf<NonNullable<T[K]>> extends never ? never : K]-?: AggregateHandleOf<NonNullable<T[K]>>;
} & {
  /** The number of matches; with a condition, the number of matches that also satisfy it. */
  count(condition?: QueryCondition): AggregateExpression<number>;
};

/** The aggregate expressions an `aggregate` lambda returns, by result name. */
export type AggregateExpressions = Record<string, AggregateExpression<unknown>>;

/** The result of `aggregate`: each expression's value under its name. */
export type AggregateResult<A extends AggregateExpressions> = {
  [K in keyof A]: A[K] extends AggregateExpression<infer V> ? V : never;
};

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

type FieldHandles = Record<string, Record<string, (value?: unknown) => QueryCondition>>;

const handlesByModel = new WeakMap<EntityModel, FieldHandles>();

/** The handles of an entity, built on its first query and reused by every later one. */
function fieldHandles(model: EntityModel): FieldHandles {
  let handles = handlesByModel.get(model);
  if (!handles) handlesByModel.set(model, (handles = buildFieldHandles(model)));
  return handles;
}

/** Builds the handles for an entity; using an operator a field does not accept throws a descriptive error. */
function buildFieldHandles(model: EntityModel): FieldHandles {
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

const NUMBER_AGGREGATES = ["sum", "avg", "min", "max"] as const;

const aggregateHandlesByModel = new WeakMap<EntityModel, Record<string, unknown>>();

/** The handles of an `aggregate` lambda, built on the entity's first aggregate and reused by every later one. */
function aggregateHandles(model: EntityModel): Record<string, unknown> {
  let handles = aggregateHandlesByModel.get(model);
  if (!handles) aggregateHandlesByModel.set(model, (handles = buildAggregateHandles(model)));
  return handles;
}

/**
 * Builds the handles of an `aggregate` lambda: copies of the field handles with the aggregate functions added, plus
 * `count`. The field handles themselves stay without aggregate functions, so `where` lambdas never see them.
 */
function buildAggregateHandles(model: EntityModel): Record<string, unknown> {
  const types = new Map<string, string>([
    ["createdAt", "date"],
    ["updatedAt", "date"],
    ...model.fields.filter((field) => field.storage === "column").map((field) => [field.name, field.type] as [string, string]),
  ]);
  const handles: Record<string, Record<string, unknown>> = {};
  for (const [name, fieldHandle] of Object.entries(fieldHandles(model))) {
    const type = types.get(name);
    const allowed: readonly string[] = type === "number" ? NUMBER_AGGREGATES : type === "date" ? ["min", "max"] : [];
    const handle: Record<string, unknown> = { ...fieldHandle };
    for (const fn of NUMBER_AGGREGATES) {
      handle[fn] = () => {
        if (!allowed.includes(fn)) throw new Error(`Aggregate "${fn}" is not allowed on ${model.entityName}.${name}`);
        return new AggregateExpression({ fn, field: name });
      };
    }
    handles[name] = handle;
  }
  const count = (condition?: QueryCondition) => {
    if (condition === undefined) return new AggregateExpression<number>({ fn: "count" });
    if (!(condition instanceof QueryCondition)) throw new Error(`count() on ${model.entityName} takes a condition`);
    return new AggregateExpression<number>({ fn: "count", where: [...condition.conditions] });
  };
  // A field named `count` keeps its operators on the function.
  return { ...handles, count: Object.assign(count, handles.count) };
}

/** Runs an aggregate lambda against an entity's handles and returns its aggregates by name. */
export function aggregatesOf<T>(model: EntityModel, lambda: (fields: AggregateFields<T>) => AggregateExpressions): Record<string, Aggregate> {
  const result: unknown = lambda(aggregateHandles(model) as unknown as AggregateFields<T>);
  const invalid = () => new Error(`An aggregate lambda on ${model.entityName} must return an object of aggregate expressions`);
  if (typeof result !== "object" || result === null || Array.isArray(result)) throw invalid();
  const aggregates: Record<string, Aggregate> = {};
  for (const [name, expression] of Object.entries(result)) {
    if (!(expression instanceof AggregateExpression)) throw invalid();
    aggregates[name] = expression.aggregate;
  }
  return aggregates;
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

/**
 * A LINQ-like query on one entity; each `where` narrows it, and a terminal method runs it. `R` maps reference fields
 * for `include`; `M` is what `aggregate` resolves when the query has no source records at all (`null` for the records
 * of a missing owner, see `related`).
 */
export interface Query<T, R = Record<never, never>, M = never> {
  /** Narrows the query with the lambda's conditions (AND with earlier calls). */
  where(lambda: QueryLambda<T>): Query<T, R, M>;
  /** Orders by a field, replacing earlier ordering. */
  orderBy(lambda: SortLambda<T>): Query<T, R, M>;
  /** Orders by a field in descending order, replacing earlier ordering. */
  orderByDescending(lambda: SortLambda<T>): Query<T, R, M>;
  /** Adds a further sort field. */
  thenBy(lambda: SortLambda<T>): Query<T, R, M>;
  /** Adds a further sort field in descending order. */
  thenByDescending(lambda: SortLambda<T>): Query<T, R, M>;
  /** Leaves out the first `count` results (not applied to `count()`, `any()` and `all()`). */
  skip(count: number): Query<T, R, M>;
  /** Returns at most `count` results (not applied to `count()`, `any()` and `all()`). */
  take(count: number): Query<T, R, M>;
  /** Returns only these fields plus `id`. */
  select<K extends keyof T & string>(...fields: K[]): Query<Pick<T, K | ("id" & keyof T)>, R, M>;
  /** Replaces reference paths with the referenced records, e.g. `include("profiles.permissions.module")`. */
  include<const P extends readonly PopulatePath<R>[]>(...paths: P): Query<Populated<T, R, P[number]>, Record<never, never>, M>;
  /** Every match; throws when there are more than `repositories.toArrayMax`. */
  toArray(): Promise<T[]>;
  /** The first match, or 404 `<Entity> not found`. */
  first(): Promise<T>;
  /** The first match, or null. */
  firstOrDefault(): Promise<T | null>;
  /** The number of matches, without loading records. */
  count(): Promise<number>;
  /**
   * Whether at least one match exists, or with a condition, whether at least one match satisfies it, without loading
   * records.
   */
  any(lambda?: QueryLambda<T>): Promise<boolean>;
  /**
   * Whether every match satisfies the condition (true when nothing matches), answered by the database in one round trip
   * without loading records.
   */
  all(lambda: QueryLambda<T>): Promise<boolean>;
  /** `{ data, total, limit, offset }` like the generated list routes. */
  page(options?: PageOptions): Promise<{ data: T[]; total: number; limit: number; offset: number }>;
  /**
   * Counts, sums, averages, minimums and maximums of the matches in one database round trip, e.g.
   * `aggregate((u) => ({ admins: u.count(u.role.eq("admin")), averageAge: u.age.avg() }))` (not limited by `skip()` and
   * `take()`).
   */
  aggregate<A extends AggregateExpressions>(lambda: (fields: AggregateFields<T>) => A): Promise<AggregateResult<A> | M>;
}

/** What a query needs from its repository. */
export interface QueryBackend {
  model: EntityModel;
  toArrayMax: number;
  /** A page of matches; `withTotal` false skips counting them (`total` is then the page size). */
  list(query: ListQuery, populate: string[], withTotal: boolean): Promise<{ data: Record<string, unknown>[]; total: number }>;
  count(where: Condition[]): Promise<number>;
  /** Every aggregate over the matches; null when the query has no source records (the owner of related records is missing). */
  aggregate(where: Condition[], aggregates: Record<string, Aggregate>): Promise<AggregateValues | null>;
  notFound(): Error;
}

interface QueryState {
  where: Condition[];
  sort: SortField[];
  skip: number;
  take?: number;
  select?: string[];
  include?: string[];
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

const AT_LEAST_ZERO = "Must be an integer of at least 0";
const LIMIT_RANGE = `Must be an integer from 1 to ${MAX_LIMIT}`;

/** Paging values usually come from the client, so they fail like the list routes' `limit` and `offset`. */
function invalidPaging(details: FieldErrorDetail[]): HttpError {
  return new HttpError(400, "Invalid query", { details });
}

function nonNegative(method: string, count: number): number {
  if (!Number.isInteger(count) || count < 0) throw invalidPaging([{ field: method, message: AT_LEAST_ZERO }]);
  return count;
}

/** A query over the backend's records with the given state; every method returns a new query. */
export function createQuery<T, R = Record<never, never>, M = never>(backend: QueryBackend, state: QueryState): Query<T, R, M> {
  const { model, toArrayMax } = backend;
  const next = (changes: Partial<QueryState>) => createQuery<T, R, M>(backend, { ...state, ...changes });
  const keyOf = (lambda: SortLambda<T>) => {
    const key = lambda(sortKeys(model) as unknown as SortFields<T>);
    if (!(key instanceof SortKey)) throw new Error(`An order lambda on ${model.entityName} must return a field`);
    return key.field;
  };
  const sorted = (sort: SortField[]) => [...sort.filter((item) => item.field !== "id"), ...(sort.some((item) => item.field === "id") ? sort.filter((item) => item.field === "id") : [{ field: "id", direction: "desc" as const }])];
  const shape = (records: Record<string, unknown>[]) =>
    (state.select ? records.map((record) => project(record, { include: ["id", ...state.select!] })) : records) as T[];
  const read = async (limit: number, offset: number, withTotal = false) => {
    const result = await backend.list(
      { where: state.where, sort: state.sort.length > 0 ? sorted(state.sort) : DEFAULT_SORT, limit, offset },
      state.include ?? [],
      withTotal,
    );
    return { ...result, data: shape(result.data) };
  };
  const count = () => backend.count(state.where);
  return {
    where: (lambda) => next({ where: [...state.where, ...conditionsOf(model, lambda)] }),
    orderBy: (lambda) => next({ sort: [{ field: keyOf(lambda), direction: "asc" }] }),
    orderByDescending: (lambda) => next({ sort: [{ field: keyOf(lambda), direction: "desc" }] }),
    thenBy: (lambda) => next({ sort: [...state.sort, { field: keyOf(lambda), direction: "asc" }] }),
    thenByDescending: (lambda) => next({ sort: [...state.sort, { field: keyOf(lambda), direction: "desc" }] }),
    skip: (value) => next({ skip: nonNegative("skip", value) }),
    take: (value) => next({ take: nonNegative("take", value) }),
    select: (...fields) => createQuery(backend, { ...state, select: fields }) as never,
    include: (...paths) => createQuery(backend, { ...state, include: [...new Set([...(state.include ?? []), ...paths])] }) as never,
    async toArray() {
      // One record past the cap shows there are too many, without counting the matches.
      const limit = Math.min(state.take ?? Number.POSITIVE_INFINITY, toArrayMax + 1);
      if (limit === 0) return [];
      const { data } = await read(limit, state.skip);
      if (data.length > toArrayMax) {
        throw new Error(`Query on ${model.entityName} matched more than repositories.toArrayMax (${toArrayMax}) records`);
      }
      return data;
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
    async any(lambda) {
      if (lambda === undefined) return (await count()) > 0;
      return (await backend.count([...state.where, ...conditionsOf(model, lambda)])) > 0;
    },
    async all(lambda) {
      if (typeof lambda !== "function") throw new Error("all() needs a condition; use toArray() to read the records");
      // The matches and those satisfying the condition, counted together in one query.
      const counts = await backend.aggregate(state.where, { matched: { fn: "count" }, satisfied: { fn: "count", where: conditionsOf(model, lambda) } });
      return counts === null || counts.matched === counts.satisfied;
    },
    async page({ limit = 20, offset = 0 }: PageOptions = {}) {
      const details: FieldErrorDetail[] = [];
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) details.push({ field: "limit", message: LIMIT_RANGE });
      if (!Number.isInteger(offset) || offset < 0) details.push({ field: "offset", message: AT_LEAST_ZERO });
      if (details.length > 0) throw invalidPaging(details);
      const size = Math.min(limit, state.take === undefined ? limit : Math.max(0, state.take - offset));
      const result = size === 0 ? { data: [] as T[], total: await count() } : await read(size, state.skip + offset, true);
      return { data: result.data, total: result.total, limit, offset };
    },
    async aggregate(lambda) {
      return (await backend.aggregate(state.where, aggregatesOf(model, lambda))) as never;
    },
  };
}
