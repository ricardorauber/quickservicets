# Repositories and queries

> Every method of repositories and fluent queries.

Endpoints and hooks receive `repos`, with one repository per entity (`repos.users`, or `repos.<schema>.<collection>`).

## Repository

`Repository<T, R, C, U>`: `T` is the record, `R` its references, `C` and `U` the create and update inputs.

### `create`

```ts
create(data: C, options?: ReadOptions): Promise<T>;
```

Validates and stores a new record (defaults applied, references checked) and returns it.

### `findById`

```ts
findById<const P extends readonly PopulatePath<R>[] = []>(id: string, options?: PopulateOptions<P>): Promise<Populated<T, R, P[number]> | null>;
```

The record with this id, or null; `populate` replaces reference paths with records.

### `findOne`

```ts
findOne<const P extends readonly PopulatePath<R>[] = []>(where: Condition[], options?: PopulateOptions<P>): Promise<Populated<T, R, P[number]> | null>;
```

The first record matching every condition, or null.

### `list`

```ts
list<const P extends readonly PopulatePath<R>[] = []>(query: ListQuery, options?: PopulateOptions<P>): Promise<ListResult<Populated<T, R, P[number]>>>;
```

A page of records for explicit conditions, sort, limit and offset, with the total.

### `findByIds`

```ts
findByIds<const P extends readonly PopulatePath<R>[] = []>(ids: readonly string[], options?: { include?: P }): Promise<Populated<T, R, P[number]>[]>;
```

Records for `ids` in that order, skipping missing ids and repeating none; `include` populates like `populate`.

### `update`

```ts
update(id: string, changes: U, options?: WriteOptions): Promise<T>;
```

Applies a partial change (reference arrays also take `{ add, remove }`) and returns the record.

### `replace`

```ts
replace(id: string, data: C, options?: WriteOptions): Promise<T>;
```

Replaces every writable field and returns the record.

### `delete`

```ts
delete(id: string, options?: Pick<WriteOptions, "ifMatch" | "tagOf">): Promise<void>;
```

Deletes the record, applying the `@onDelete` rules of the records that reference it; `ifMatch` makes it conditional.

### `populate`

```ts
populate(records: T[], paths: readonly string[]): Promise<T[]>;
```

Populates reference paths on records already loaded, e.g. results of a custom endpoint.

### `createWith`

```ts
createWith(id: string, managed: Record<string, unknown>, data: unknown): Promise<T>;
```

Creates a record whose framework-managed fields (e.g. a file's metadata) and id are already known.

### `replaceWith`

```ts
replaceWith(id: string, managed: Record<string, unknown>, data: unknown): Promise<T>;
```

Replaces a record like `replace`, also setting framework-managed fields.

### `where`

```ts
where(lambda: QueryLambda<T>): Query<T, R>;
```

A fluent query filtered by the lambda's conditions.

### `query`

```ts
query(): Query<T, R>;
```

A fluent query over every record.

### `any`

```ts
any(lambda?: QueryLambda<T>): Promise<boolean>;
```

Whether any record exists, or with a condition, whether any record satisfies it; `query().any(lambda)`.

### `all`

```ts
all(lambda: QueryLambda<T>): Promise<boolean>;
```

Whether every record satisfies the condition (true when there are none); `query().all(lambda)`.

### `none`

```ts
none(lambda?: QueryLambda<T>): Promise<boolean>;
```

Whether no record exists, or with a condition, whether no record satisfies it; `query().none(lambda)`.

### `count`

```ts
count(lambda?: QueryLambda<T>): Promise<number>;
```

The number of records, or with a condition, of records satisfying it; `where(lambda).count()`.

### `related`

```ts
related<K extends RelatedField<R>>(id: string, field: K): Query<RelatedRecord<R, K>, RelatedReferences<R, K>, null>;
```

A fluent query over the records the reference array `field` of record `id` lists, e.g.
`related(orgId, "members")`. It has no records when that record does not exist, and its `aggregate` then resolves
null.

## Query

`Query<T, R, M>`, returned by `where`, `query` and `related`; every method but the terminals returns a new query. `M` is `null` on `related` queries, whose `aggregate` resolves null when the record does not exist.

### `where`

```ts
where(lambda: QueryLambda<T>): Query<T, R, M>;
```

Narrows the query with the lambda's conditions (AND with earlier calls).

### `orderBy`

```ts
orderBy(lambda: SortLambda<T>): Query<T, R, M>;
```

Orders by a field, replacing earlier ordering.

### `orderByDescending`

```ts
orderByDescending(lambda: SortLambda<T>): Query<T, R, M>;
```

Orders by a field in descending order, replacing earlier ordering.

### `thenBy`

```ts
thenBy(lambda: SortLambda<T>): Query<T, R, M>;
```

Adds a further sort field.

### `thenByDescending`

```ts
thenByDescending(lambda: SortLambda<T>): Query<T, R, M>;
```

Adds a further sort field in descending order.

### `skip`

```ts
skip(count: number): Query<T, R, M>;
```

Leaves out the first `count` results (not applied to `count()`, `any()`, `all()` and `none()`).

### `take`

```ts
take(count: number): Query<T, R, M>;
```

Returns at most `count` results (not applied to `count()`, `any()`, `all()` and `none()`).

### `select`

```ts
select<K extends keyof T & string>(...fields: K[]): Query<Pick<T, K | ("id" & keyof T)>, R, M>;
```

Returns only these fields plus `id`.

### `include`

```ts
include<const P extends readonly PopulatePath<R>[]>(...paths: P): Query<Populated<T, R, P[number]>, Record<never, never>, M>;
```

Replaces reference paths with the referenced records, e.g. `include("profiles.permissions.module")`.

### `toArray`

```ts
toArray(): Promise<T[]>;
```

Every match; throws when there are more than `repositories.toArrayMax`.

### `first`

```ts
first(): Promise<T>;
```

The first match, or 404 `<Entity> not found`.

### `firstOrDefault`

```ts
firstOrDefault(): Promise<T | null>;
```

The first match, or null.

### `count`

```ts
count(): Promise<number>;
```

The number of matches, without loading records.

### `any`

```ts
any(lambda?: QueryLambda<T>): Promise<boolean>;
```

Whether at least one match exists, or with a condition, whether at least one match satisfies it, without loading
records.

### `all`

```ts
all(lambda: QueryLambda<T>): Promise<boolean>;
```

Whether every match satisfies the condition (true when nothing matches), answered by the database in one round trip
without loading records.

### `none`

```ts
none(lambda?: QueryLambda<T>): Promise<boolean>;
```

Whether no match exists, or with a condition, whether no match satisfies it (`!(await any(lambda))`), without
loading records.

### `page`

```ts
page(options?: PageOptions): Promise<{ data: T[]; total: number; limit: number; offset: number }>;
```

`{ data, total, limit, offset }` like the generated list routes.

### `aggregate`

```ts
aggregate<A extends AggregateExpressions>(lambda: (fields: AggregateFields<T>) => A): Promise<AggregateResult<A> | M>;
```

Counts, sums, averages, minimums and maximums of the matches in one database round trip, e.g.
`aggregate((u) => ({ admins: u.count(u.role.eq("admin")), averageAge: u.age.avg() }))` (not limited by `skip()` and
`take()`).

## QueryCondition

`QueryCondition`, returned by the field handles of a query lambda (`u.role.eq("admin")`) and accepted wherever a condition is: `where`, `any`, `all`, `none`, the repository's `count` and an aggregate's `count(condition)`.

### `and`

```ts
and(other: QueryCondition): QueryCondition;
```

Both this condition and `other`: `a.and(b.or(c))` is `a AND (b OR c)`.

### `or`

```ts
or(other: QueryCondition): QueryCondition;
```

This condition or `other`: `a.or(b).and(c)` is `(a OR b) AND c`.

### `not`

```ts
not(): QueryCondition;
```

Every record for which this condition is not true, including records where a compared field is null or missing:
`a.and(b).not()` is `NOT (a AND b)`.
