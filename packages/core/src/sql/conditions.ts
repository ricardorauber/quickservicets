import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { isConditionGroup, type Condition, type FieldCondition, type SizeFilter, type SortField } from "../query.ts";
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

const SIZE_OPERATORS: Record<SizeFilter["compare"], string> = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };

function translateRelation(table: Columns, condition: FieldCondition, context: RelationContext): SQL {
  const junction = context.schema.junctions[junctionKey(context.entity.key, condition.field)] as Record<string, unknown>;
  const owned = sql`${junction.ownerId} = ${table.id}`;
  switch (condition.op) {
    case "contains":
      return sql`exists (select 1 from ${junction} where ${owned} and ${junction.targetId} = ${condition.value})`;
    case "containsAny":
      return sql`exists (select 1 from ${junction} where ${owned} and ${inArray(junction.targetId as never, condition.value as string[])})`;
    case "containsAll": {
      const ids = condition.value as string[];
      return sql`(select count(*) from ${junction} where ${owned} and ${inArray(junction.targetId as never, ids)}) = ${ids.length}`;
    }
    case "size": {
      const { compare, count } = condition.value as SizeFilter;
      return sql`(select count(*) from ${junction} where ${owned}) ${sql.raw(SIZE_OPERATORS[compare])} ${count}`;
    }
    case "isEmpty":
      return condition.value
        ? sql`not exists (select 1 from ${junction} where ${owned})`
        : sql`exists (select 1 from ${junction} where ${owned})`;
    default:
      throw new Error(`Operator ${condition.op} is not supported on reference arrays`);
  }
}

function translate(table: Columns, condition: Condition, dialect: SqlDialect, context?: RelationContext): SQL {
  if (isConditionGroup(condition)) {
    // An empty AND matches everything; an empty OR matches nothing.
    if (condition.conditions.length === 0) return condition.group === "or" ? sql`1 = 0` : sql`1 = 1`;
    const parts = condition.conditions.map((inner) => translate(table, inner, dialect, context));
    return (condition.group === "or" ? or(...parts) : and(...parts))!;
  }
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
    default:
      throw new Error(`Operator ${condition.op} only applies to reference arrays`);
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
