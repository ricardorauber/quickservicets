import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, notInArray, sql, type SQL } from "drizzle-orm";
import type { Condition, SortField } from "../query.ts";
import type { EntityModel } from "../model.ts";
import { junctionKey, type DrizzleSchema, type SqlDialect } from "./schema.ts";

// Drizzle columns are looked up by field name on dynamically built tables.
type Columns = Record<string, unknown>;

/** Escapes LIKE wildcards so the value matches literally with `ESCAPE '\'`. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function column(table: Columns, field: string): never {
  const found = table[field];
  if (found === undefined) throw new Error(`Unknown column for field "${field}"`);
  return found as never;
}

function textMatch(target: never, pattern: string, dialect: SqlDialect): SQL {
  return dialect === "postgres"
    ? sql`${target} ilike ${pattern} escape '\\'`
    : sql`lower(${target}) like lower(${pattern}) escape '\\'`;
}

/** Entity and schema used to translate conditions on reference arrays (stored in junction tables). */
export interface RelationContext {
  entity: EntityModel;
  schema: DrizzleSchema;
}

function translateRelation(table: Columns, condition: Condition, context: RelationContext): SQL {
  const junction = context.schema.junctions[junctionKey(context.entity.key, condition.field)] as Record<string, unknown>;
  if (condition.op !== "contains") throw new Error(`Operator ${condition.op} is not supported on reference arrays`);
  return sql`exists (select 1 from ${junction} where ${junction.ownerId} = ${table.id} and ${junction.targetId} = ${condition.value})`;
}

function translate(table: Columns, condition: Condition, dialect: SqlDialect, context?: RelationContext): SQL {
  const relation = context?.entity.fields.find((field) => field.name === condition.field && field.type === "refArray");
  if (relation && context) return translateRelation(table, condition, context);
  const target = column(table, condition.field);
  const { value } = condition;
  switch (condition.op) {
    case "eq":
      return eq(target, value);
    case "ne":
      return ne(target, value);
    case "in":
      return inArray(target, value as unknown[]);
    case "nin":
      return notInArray(target, value as unknown[]);
    case "gt":
      return gt(target, value);
    case "gte":
      return gte(target, value);
    case "lt":
      return lt(target, value);
    case "lte":
      return lte(target, value);
    case "contains":
      return textMatch(target, `%${escapeLike(String(value))}%`, dialect);
    case "startsWith":
      return textMatch(target, `${escapeLike(String(value))}%`, dialect);
    case "exists":
      return value ? isNotNull(target) : isNull(target);
    case "isNull":
      return value ? isNull(target) : isNotNull(target);
  }
}

/** Translates list conditions (combined with AND) into a Drizzle SQL expression. */
export function toWhere(table: Columns, conditions: Condition[], dialect: SqlDialect, context?: RelationContext): SQL | undefined {
  if (conditions.length === 0) return undefined;
  return and(...conditions.map((condition) => translate(table, condition, dialect, context)));
}

export function toOrderBy(table: Columns, sort: SortField[]): SQL[] {
  return sort.map(({ field, direction }) => (direction === "asc" ? asc(column(table, field)) : desc(column(table, field))));
}
