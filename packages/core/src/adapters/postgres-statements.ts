import { getTableColumns } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import type { StoredRecord } from "../adapter.ts";
import type { EntityModel } from "../model.ts";
import { isConditionGroup, type Condition } from "../query.ts";
import { junctionKey, type DrizzleSchema } from "../sql/schema.ts";

/** A quoted SQL identifier. */
export const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

/** A PostgreSQL text array literal, bound as one `$n::text[]` parameter whatever the number of values. */
export function textArray(values: readonly string[]): string {
  return `{${values.map((value) => `"${value.replace(/[\\"]/g, (char) => `\\${char}`)}"`).join(",")}}`;
}

/** The quoted, schema-qualified name of a Drizzle table (unqualified tables use the connection's search path). */
export function qualifiedName(table: PgTable): string {
  const { name, schema } = getTableConfig(table);
  return schema ? `${quote(schema)}.${quote(name)}` : quote(name);
}

type ColumnKind = "json" | "date" | "value";

interface Column {
  /** Field name, used as the column alias. */
  field: string;
  /** Quoted column name. */
  name: string;
  kind: ColumnKind;
}

const KINDS: Record<string, ColumnKind> = { PgJsonb: "json", PgTimestamp: "date" };

/** Converts a field value to the parameter PostgreSQL stores, as Drizzle's column mappers do. */
function encode(kind: ColumnKind, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (kind === "json") return JSON.stringify(value);
  if (kind === "date" && value instanceof Date) return value.toISOString();
  return value;
}

const SIMPLE_OPERATORS: Record<string, string> = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };

/** SQL text with its parameters. */
export interface Statement {
  text: string;
  params: unknown[];
}

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
export class EntityStatements {
  readonly table: string;
  readonly junctions: Junction[];
  private readonly columns = new Map<string, Column>();
  private readonly jsonFields: string[];
  private readonly selectList: string;
  private readonly texts = new Map<string, string>();

  constructor(entity: EntityModel, schema: DrizzleSchema) {
    const table = schema.tables[entity.key] as PgTable;
    this.table = qualifiedName(table);
    for (const [field, column] of Object.entries(getTableColumns(table))) {
      this.columns.set(field, { field, name: quote(column.name), kind: KINDS[column.columnType] ?? "value" });
    }
    this.jsonFields = [...this.columns.values()].filter((column) => column.kind === "json").map((column) => column.field);
    this.selectList = [...this.columns.values()].map(({ field, name }) => (name === quote(field) ? name : `${name} as ${quote(field)}`)).join(", ");
    this.junctions = entity.fields.flatMap((field) => {
      const junction = field.storage === "relation" ? (schema.junctions[junctionKey(entity.key, field.name)] as PgTable | undefined) : undefined;
      return junction ? [{ field: field.name, name: qualifiedName(junction) }] : [];
    });
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

  /** Written columns in a stable order, skipping undefined values and keys that are not columns. */
  private written(values: Record<string, unknown>): string[] {
    return Object.keys(values)
      .filter((field) => values[field] !== undefined && this.columns.has(field))
      .sort();
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

  findById(id: string) {
    return { text: this.text("findById", () => `select ${this.selectList} from ${this.table} where "id" = $1 limit 1`), params: [id] };
  }

  insert(values: Record<string, unknown>) {
    const fields = this.written(values);
    const text = this.text(`insert:${fields.join(",")}`, () => {
      const names = fields.map((field) => this.columns.get(field)!.name).join(", ");
      const placeholders = fields.map((_, index) => `$${index + 1}`).join(", ");
      return `insert into ${this.table} (${names}) values (${placeholders}) returning ${this.selectList}`;
    });
    return { text, params: fields.map((field) => encode(this.columns.get(field)!.kind, values[field])) };
  }

  /**
   * Updates the record with that id when it also matches `where`, or reads it when nothing is written. Only plain
   * comparisons of columns with non-null values are precompiled; any other `where` returns undefined.
   */
  updateById(id: string, values: Record<string, unknown>, where: Condition[]) {
    const conditions = this.simpleConditions(where);
    if (!conditions) return undefined;
    const fields = this.written(values);
    const shape = conditions.map(({ field, op }) => `${field}:${op}`).join(",");
    const text = this.text(`update:${fields.join(",")}|${shape}`, () => {
      const filters = [`"id" = $${fields.length + 1}`, ...conditions.map(({ field, op }, index) => `${this.columns.get(field)!.name} ${SIMPLE_OPERATORS[op]} $${fields.length + 2 + index}`)];
      if (fields.length === 0) return `select ${this.selectList} from ${this.table} where ${filters.join(" and ")}`;
      const assignments = fields.map((field, index) => `${this.columns.get(field)!.name} = $${index + 1}`).join(", ");
      return `update ${this.table} set ${assignments} where ${filters.join(" and ")} returning ${this.selectList}`;
    });
    const params = [
      ...fields.map((field) => encode(this.columns.get(field)!.kind, values[field])),
      id,
      ...conditions.map(({ field, value }) => encode(this.columns.get(field)!.kind, value)),
    ];
    return { text, params };
  }

  deleteById(id: string) {
    return { text: this.text("deleteById", () => `delete from ${this.table} where "id" = $1 returning "id"`), params: [id] };
  }

  /**
   * Deletes the record and, in the same statement, the junction rows of `pulls` that point to it, moving the
   * `updatedAt` of their owners forward: one update per owner table, so no row is changed twice.
   */
  deleteAndPull(id: string, pulls: PullTarget[], updatedAt: Date) {
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

  lockForUpdate(id: string) {
    return { text: this.text("lock", () => `select "id" from ${this.table} where "id" = $1 for update`), params: [id] };
  }

  /** Ids of every reference array of the owners in `ids`, in position order. */
  junctionLoad(junction: Junction, ids: readonly string[]) {
    const text = this.text(
      `junction:${junction.field}`,
      () => `select "owner_id" as "ownerId", "target_id" as "targetId" from ${junction.name} where "owner_id" = any($1::text[]) order by "owner_id", "position"`,
    );
    return { text, params: [textArray(ids)] };
  }

  private simpleConditions(where: Condition[]) {
    const conditions: { field: string; op: string; value: unknown }[] = [];
    for (const condition of where) {
      if (isConditionGroup(condition) || !(condition.op in SIMPLE_OPERATORS) || !this.columns.has(condition.field)) return undefined;
      if (condition.value === null || condition.value === undefined) return undefined;
      conditions.push(condition);
    }
    return conditions;
  }
}
