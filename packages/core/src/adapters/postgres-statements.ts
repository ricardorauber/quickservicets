import { getTableColumns } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import type { Aggregate, AggregateValues, StoredRecord } from "../adapter.ts";
import type { EntityModel } from "../model.ts";
import type { Condition, SortField } from "../query.ts";
import { junctionKey, type DrizzleSchema } from "../sql/schema.ts";
import { compileConditions, compileSort, encodeValue, type ColumnKind, type ConditionTarget, type TargetColumn } from "./postgres-conditions.ts";

/** A quoted SQL identifier. */
export const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

/** The quoted, schema-qualified name of a Drizzle table (unqualified tables use the connection's search path). */
export function qualifiedName(table: PgTable): string {
  const { name, schema } = getTableConfig(table);
  return schema ? `${quote(schema)}.${quote(name)}` : quote(name);
}

interface Column extends TargetColumn {
  /** Field name, used as the column alias. */
  field: string;
}

// pgvector reads and writes vectors as JSON-like text (`[1,2,3]`), so they are encoded and decoded like JSON.
const KINDS: Record<string, ColumnKind> = { PgJsonb: "json", PgTimestamp: "date", PgVector: "json" };
const TYPES: Record<string, string> = { PgDoublePrecision: "float8", PgTimestamp: "timestamptz", PgBoolean: "boolean", PgInteger: "int4", PgJsonb: "jsonb", PgVector: "vector" };

/** SQL text with its parameters. */
export interface Statement {
  text: string;
  params: unknown[];
}

/** An aggregate statement and the decoding of its row into values by aggregate name. */
export type AggregateStatement = Statement & { decode(row: Record<string, unknown>): AggregateValues };

/** A reference array to pull from: the owner's statements and the junction storing the array. */
export interface PullTarget {
  owner: EntityStatements;
  junction: Junction;
}

/** Junction table of a reference array, with the alias of the field it stores. */
export interface Junction {
  field: string;
  name: string;
}

/**
 * The SQL text of one entity's statements, built once per statement shape and cached, with the conversion of values
 * to parameters and of rows back to records.
 */
export class EntityStatements implements ConditionTarget {
  readonly table: string;
  readonly junctions: Junction[];
  private readonly columns = new Map<string, Column>();
  private readonly junctionNames: Map<string, string>;
  private readonly jsonFields: string[];
  /** The entity's own columns, aliased to their field names. */
  private readonly columnList: string;
  /** The own columns plus every junction-stored reference array, aggregated in position order. */
  private readonly selectList: string;
  private readonly arrayList: string[];
  /** Select lists leaving out some columns, by the omitted fields. */
  private readonly partialLists = new Map<string, string>();
  private readonly texts = new Map<string, string>();

  constructor(entity: EntityModel, schema: DrizzleSchema) {
    const table = schema.tables[entity.key] as PgTable;
    this.table = qualifiedName(table);
    for (const [field, column] of Object.entries(getTableColumns(table))) {
      this.columns.set(field, { field, name: quote(column.name), kind: KINDS[column.columnType] ?? "value", type: TYPES[column.columnType] ?? "text" });
    }
    this.jsonFields = [...this.columns.values()].filter((column) => column.kind === "json").map((column) => column.field);
    this.columnList = [...this.columns.values()].map(({ field, name }) => (name === quote(field) ? name : `${name} as ${quote(field)}`)).join(", ");
    this.junctions = entity.fields.flatMap((field) => {
      const junction = field.storage === "relation" ? (schema.junctions[junctionKey(entity.key, field.name)] as PgTable | undefined) : undefined;
      return junction ? [{ field: field.name, name: qualifiedName(junction) }] : [];
    });
    const arrays = this.junctions.map(
      ({ field, name }) =>
        `coalesce((select array_agg(${name}."target_id" order by ${name}."position") from ${name} where ${name}."owner_id" = ${this.table}."id"), '{}') as ${quote(field)}`,
    );
    this.arrayList = arrays;
    this.selectList = [this.columnList, ...arrays].join(", ");
    this.junctionNames = new Map(this.junctions.map((junction) => [junction.field, junction.name]));
  }

  /** The select list without the omitted columns, and the suffix that keys its statements in the cache. */
  private selection(omit: readonly string[] | undefined): { key: string; list: string } {
    const omitted = omit?.filter((field) => field !== "id" && this.columns.has(field)) ?? [];
    if (omitted.length === 0) return { key: "", list: this.selectList };
    const key = [...new Set(omitted)].sort().join(",");
    let list = this.partialLists.get(key);
    if (list === undefined) {
      const kept = [...this.columns.values()].filter((column) => !omitted.includes(column.field));
      const columns = kept.map(({ field, name }) => (name === quote(field) ? name : `${name} as ${quote(field)}`));
      list = [...columns, ...this.arrayList].join(", ");
      this.partialLists.set(key, list);
    }
    return { key: `-${key}`, list };
  }

  column(field: string): TargetColumn | undefined {
    return this.columns.get(field);
  }

  junction(field: string): string | undefined {
    return this.junctionNames.get(field);
  }

  /** The cached text for a statement shape, built the first time it is used. */
  private text(key: string, build: () => string): string {
    let text = this.texts.get(key);
    if (text === undefined) {
      text = build();
      this.texts.set(key, text);
    }
    return text;
  }

  /** Whether the text of a statement shape is already built (exposed for tests of the cache). */
  cached(key: string): boolean {
    return this.texts.has(key);
  }

  /**
   * A statement whose text depends on a WHERE clause: the conditions are translated with text only the first time the
   * shape is seen; afterwards only their parameters are collected.
   */
  private withConditions(prefix: string, where: readonly Condition[], firstParam: number, build: (clause: string, paramCount: number) => string) {
    const compiled = compileConditions(where, this, firstParam, false);
    const key = `${prefix}|${compiled.key}`;
    const text = this.text(key, () => build(compileConditions(where, this, firstParam).text ?? "", compiled.params.length));
    return { key, text, params: compiled.params };
  }

  /** Written columns in a stable order, skipping undefined values and keys that are not columns. */
  private written(values: Record<string, unknown>): string[] {
    return Object.keys(values)
      .filter((field) => values[field] !== undefined && this.columns.has(field))
      .sort();
  }

  private encode(field: string, value: unknown): unknown {
    return encodeValue(this.columns.get(field)!.kind, value);
  }

  /** Records from result rows: JSON columns parsed when the driver returns their text. */
  records(rows: Record<string, unknown>[]): StoredRecord[] {
    if (this.jsonFields.length > 0) {
      for (const row of rows) {
        for (const field of this.jsonFields) {
          const value = row[field];
          if (typeof value === "string") {
            try {
              row[field] = JSON.parse(value);
            } catch {
              // Not JSON text: kept as stored.
            }
          }
        }
      }
    }
    return rows as StoredRecord[];
  }

  findById(id: string, omit?: readonly string[]): Statement {
    const { key, list } = this.selection(omit);
    return { text: this.text(`findById${key}`, () => `select ${list} from ${this.table} where "id" = $1 limit 1`), params: [id] };
  }

  findOne(where: readonly Condition[]): Statement {
    const { text, params } = this.withConditions("findOne", where, 1, (clause) => `select ${this.selectList} from ${this.table}${clause ? ` where ${clause}` : ""} limit 1`);
    return { text, params };
  }

  /** A page of records matching `where`, in `sort` order. */
  findMany(where: readonly Condition[], sort: readonly SortField[], limit: number, offset: number, omit?: readonly string[]): Statement & { key: string } {
    const order = compileSort(sort, this);
    const selection = this.selection(omit);
    const { key, text, params } = this.withConditions(`findMany${selection.key}:${order.key}`, where, 1, (clause, at) => {
      const filter = clause ? ` where ${clause}` : "";
      const ordering = order.text ? ` order by ${order.text}` : "";
      return `select ${selection.list} from ${this.table}${filter}${ordering} limit $${at + 1} offset $${at + 2}`;
    });
    return { key, text, params: [...params, limit, offset] };
  }

  count(where: readonly Condition[]): Statement {
    const { text, params } = this.withConditions("count", where, 1, (clause) => `select count(*) as "total" from ${this.table}${clause ? ` where ${clause}` : ""}`);
    return { text, params };
  }

  /** The rows a junction lists for the owner id in `$1`, as a condition on this table. */
  private listedBy(junction: string): string {
    return `${this.table}."id" in (select "target_id" from ${junction} where "owner_id" = $1)`;
  }

  /** A page of the records `junction` lists for owner `ownerId` that match `where`, in `sort` order. */
  findRelated(junction: string, ownerId: string, where: readonly Condition[], sort: readonly SortField[], limit: number, offset: number): Statement {
    const order = compileSort(sort, this);
    const { text, params } = this.withConditions(`findRelated:${junction}:${order.key}`, where, 2, (clause, at) => {
      const ordering = order.text ? ` order by ${order.text}` : "";
      return `select ${this.selectList} from ${this.table} where ${this.listedBy(junction)}${clause ? ` and ${clause}` : ""}${ordering} limit $${at + 2} offset $${at + 3}`;
    });
    return { text, params: [ownerId, ...params, limit, offset] };
  }

  /** The number of records `junction` lists for owner `ownerId` that match `where`. */
  countRelated(junction: string, ownerId: string, where: readonly Condition[]): Statement {
    const { text, params } = this.withConditions(`countRelated:${junction}`, where, 2, (clause) => {
      return `select count(*) as "total" from ${this.table} where ${this.listedBy(junction)}${clause ? ` and ${clause}` : ""}`;
    });
    return { text, params: [ownerId, ...params] };
  }

  /** Every aggregate in one statement; counts with conditions use `filter (where …)`. */
  aggregate(where: readonly Condition[], aggregates: Record<string, Aggregate>): AggregateStatement {
    return this.aggregateOver("aggregate", where, aggregates, [], "*", (clause) => `from ${this.table}${clause ? ` where ${clause}` : ""}`);
  }

  /**
   * Every aggregate over the records `junction` lists for owner `ownerId`, in one statement: the owner left-joined to
   * its junction rows and to the matching records, so a missing owner gives no row and an owner without matches one
   * row of 0 counts and null aggregates.
   */
  aggregateRelated(owner: string, junction: string, ownerId: string, where: readonly Condition[], aggregates: Record<string, Aggregate>): AggregateStatement {
    return this.aggregateOver(`aggregateRelated:${owner}:${junction}`, where, aggregates, [ownerId], `${this.table}."id"`, (clause) => {
      const matching = `${this.table}."id" = "related"."target_id"${clause ? ` and ${clause}` : ""}`;
      return `from ${owner} as "owner" left join ${junction} as "related" on "related"."owner_id" = "owner"."id" left join ${this.table} on ${matching} where "owner"."id" = $1 group by "owner"."id"`;
    });
  }

  /**
   * An aggregate statement after the `leading` parameters: `counted` is what counts count (`*`, or a column that is
   * null for rows without a match), and `source` the FROM part around the WHERE clause.
   */
  private aggregateOver(
    prefix: string,
    where: readonly Condition[],
    aggregates: Record<string, Aggregate>,
    leading: unknown[],
    counted: string,
    source: (clause: string) => string,
  ): AggregateStatement {
    const entries = Object.entries(aggregates);
    const first = leading.length + 1;
    const filters: { key: string; params: unknown[] }[] = [];
    const expressionKeys = entries.map(([name, aggregate]) => {
      if (aggregate.fn !== "count") return `${JSON.stringify(name)}=${aggregate.fn}(${aggregate.field})`;
      const filter = compileConditions(aggregate.where ?? [], this, first, false);
      filters.push(filter);
      return `${JSON.stringify(name)}=count(${filter.key})`;
    });
    const filterParams = filters.flatMap((filter) => filter.params);
    const { text, params } = this.withConditions(`${prefix}:${expressionKeys.join(",")}`, where, first + filterParams.length, (clause) => {
      let next = first;
      const expressions = entries.map(([name, aggregate]) => {
        if (aggregate.fn === "count") {
          const filter = compileConditions(aggregate.where ?? [], this, next);
          next += filter.params.length;
          return `${filter.text ? `count(${counted}) filter (where ${filter.text})` : `count(${counted})`} as ${quote(name)}`;
        }
        const column = this.columns.get(aggregate.field);
        if (!column) throw new Error(`Unknown column for field "${aggregate.field}"`);
        return `${aggregate.fn}(${this.table}.${column.name}) as ${quote(name)}`;
      });
      return `select ${expressions.join(", ")} ${source(clause)}`;
    });
    const decode = (row: Record<string, unknown>): AggregateValues => {
      const values: AggregateValues = {};
      for (const [name, aggregate] of entries) {
        const value = row[name];
        if (value === null || value === undefined) values[name] = aggregate.fn === "count" ? 0 : null;
        else if (aggregate.fn === "count" || aggregate.fn === "sum" || aggregate.fn === "avg") values[name] = Number(value);
        else if (this.columns.get(aggregate.field)?.kind === "date") values[name] = value instanceof Date ? value : new Date(value as string);
        else values[name] = value as number;
      }
      return values;
    };
    return { text, params: [...leading, ...filterParams, ...params], decode };
  }

  insert(values: Record<string, unknown>): Statement {
    const fields = this.written(values);
    const text = this.text(`insert:${fields.join(",")}`, () => {
      const names = fields.map((field) => this.columns.get(field)!.name).join(", ");
      const placeholders = fields.map((_, index) => `$${index + 1}`).join(", ");
      // Reference arrays are written after the row, so they are not read back here.
      return `insert into ${this.table} (${names}) values (${placeholders}) returning ${this.columnList}`;
    });
    return { text, params: fields.map((field) => this.encode(field, values[field])) };
  }

  /** Inserts the record unless it conflicts with a unique column of a stored row, returning no row then. */
  insertOrSkip(values: Record<string, unknown>): Statement {
    const fields = this.written(values);
    const text = this.text(`insert-or-skip:${fields.join(",")}`, () => {
      const names = fields.map((field) => this.columns.get(field)!.name).join(", ");
      const placeholders = fields.map((_, index) => `$${index + 1}`).join(", ");
      return `insert into ${this.table} (${names}) values (${placeholders}) on conflict do nothing returning ${this.columnList}`;
    });
    return { text, params: fields.map((field) => this.encode(field, values[field])) };
  }

  /**
   * Inserts the record, or adds the amounts to the fields of the stored one with its id, in one statement: concurrent
   * calls never lose a count.
   */
  increment(values: Record<string, unknown>, amounts: Record<string, number>): Statement {
    const fields = this.written(values);
    const added = Object.keys(amounts).filter((field) => this.columns.has(field));
    const text = this.text(`increment:${fields.join(",")}:${added.join(",")}`, () => {
      const names = fields.map((field) => this.columns.get(field)!.name).join(", ");
      const placeholders = fields.map((_, index) => `$${index + 1}`).join(", ");
      const assignments = added.map((field) => {
        const name = this.columns.get(field)!.name;
        return `${name} = "current".${name} + excluded.${name}`;
      });
      return `insert into ${this.table} as "current" (${names}) values (${placeholders}) on conflict ("id") do update set ${assignments.join(", ")} returning ${this.columnList}`;
    });
    return { text, params: fields.map((field) => this.encode(field, values[field])) };
  }

  /** Updates the record with that id when it also matches `where`, or reads it when nothing is written. */
  updateById(id: string, values: Record<string, unknown>, where: readonly Condition[]): Statement {
    const fields = this.written(values);
    const { text, params } = this.withConditions(`update:${fields.join(",")}`, where, fields.length + 2, (clause) => {
      const filter = `${this.table}."id" = $${fields.length + 1}${clause ? ` and ${clause}` : ""}`;
      if (fields.length === 0) return `select ${this.selectList} from ${this.table} where ${filter}`;
      const assignments = fields.map((field, index) => `${this.columns.get(field)!.name} = $${index + 1}`).join(", ");
      return `update ${this.table} set ${assignments} where ${filter} returning ${this.selectList}`;
    });
    return { text, params: [...fields.map((field) => this.encode(field, values[field])), id, ...params] };
  }

  deleteById(id: string): Statement {
    return { text: this.text("deleteById", () => `delete from ${this.table} where "id" = $1 returning "id"`), params: [id] };
  }

  /**
   * Deletes the record and, in the same statement, the junction rows of `pulls` that point to it, moving the
   * `updatedAt` of their owners forward: one update per owner table, so no row is changed twice.
   */
  deleteAndPull(id: string, pulls: PullTarget[], updatedAt: Date): Statement {
    const shape = pulls.map((pull) => `${pull.owner.table}.${pull.junction.field}`).join(",");
    const text = this.text(`deleteAndPull:${shape}`, () => {
      const owners = Map.groupBy(pulls.map((pull, index) => ({ ...pull, name: `"pulled_${index}"` })), (pull) => pull.owner);
      const deletes = [...owners.values()].flat().map(({ junction, name }) => `${name} as (delete from ${junction.name} where "target_id" = $1 returning "owner_id")`);
      const updates = [...owners].map(([owner, ownerPulls], index) => {
        const holders = ownerPulls.map(({ name }) => `select "owner_id" from ${name}`).join(" union ");
        // A record holding its own id is deleted by this statement, so it is not updated as well.
        const others = owner === this ? ` and "id" <> $1` : "";
        return `"touched_${index}" as (update ${owner.table} set "updated_at" = greatest($2::timestamptz, "updated_at" + interval '1 millisecond') where "id" in (${holders})${others})`;
      });
      return `with ${[...deletes, ...updates].join(", ")} delete from ${this.table} where "id" = $1 returning "id"`;
    });
    return { text, params: [id, updatedAt.toISOString()] };
  }

  lockForUpdate(id: string): Statement {
    return { text: this.text("lock", () => `select "id" from ${this.table} where "id" = $1 for update`), params: [id] };
  }
}
