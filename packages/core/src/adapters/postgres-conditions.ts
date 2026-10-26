import { isConditionGroup, type Condition, type FieldCondition, type SizeFilter, type SortField } from "../query.ts";
import { escapeLike } from "../sql/conditions.ts";

/** How a column's values become parameters. */
export type ColumnKind = "json" | "date" | "value";

/** A column conditions can refer to: its quoted name, how values are encoded and its SQL type (for array parameters). */
export interface TargetColumn {
  name: string;
  kind: ColumnKind;
  type: string;
}

/** The table conditions apply to: its columns by field name and the junction tables of its reference arrays. */
export interface ConditionTarget {
  /** Quoted, schema-qualified table name, used to qualify column references. */
  readonly table: string;
  column(field: string): TargetColumn | undefined;
  /** Quoted, schema-qualified junction table of a reference array, or undefined for other fields. */
  junction(field: string): string | undefined;
}

/** A translation: the shape key (same key, same text), the parameters in order and, when asked for, the SQL text. */
export interface CompiledConditions {
  key: string;
  params: unknown[];
  text?: string;
}

/** Converts a field value to the parameter PostgreSQL stores, as Drizzle's column mappers do. */
export function encodeValue(kind: ColumnKind, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (kind === "json") return JSON.stringify(value);
  if (kind === "date" && value instanceof Date) return value.toISOString();
  return value;
}

/** A PostgreSQL array literal of `values`, bound as one `$n::<type>[]` parameter whatever the number of values. */
export function arrayLiteral(values: readonly unknown[]): string {
  const item = (value: unknown) => {
    if (value === null || value === undefined) return "NULL";
    const text = value instanceof Date ? value.toISOString() : String(value);
    return `"${text.replace(/[\\"]/g, (char) => `\\${char}`)}"`;
  };
  return `{${values.map(item).join(",")}}`;
}

const COMPARISONS: Record<string, string> = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };

class Translation {
  key = "";
  readonly params: unknown[] = [];
  readonly parts: string[] | undefined;

  constructor(
    readonly target: ConditionTarget,
    private readonly firstParam: number,
    withText: boolean,
  ) {
    this.parts = withText ? [] : undefined;
  }

  /** Adds a parameter and returns its placeholder. */
  param(value: unknown): string {
    this.params.push(value);
    return `$${this.firstParam + this.params.length - 1}`;
  }

  emit(text: string): void {
    this.parts?.push(text);
  }
}

function translateRelation(out: Translation, junction: string, condition: FieldCondition): void {
  const owned = `${junction}."owner_id" = ${out.target.table}."id"`;
  const target = `${junction}."target_id"`;
  out.key += `${condition.field}:${condition.op}`;
  switch (condition.op) {
    case "contains":
      out.emit(`exists (select 1 from ${junction} where ${owned} and ${target} = ${out.param(condition.value)})`);
      return;
    case "containsAny":
      out.emit(`exists (select 1 from ${junction} where ${owned} and ${target} = any(${out.param(arrayLiteral(condition.value as string[]))}::text[]))`);
      return;
    case "containsAll": {
      const ids = condition.value as string[];
      const list = out.param(arrayLiteral(ids));
      out.emit(`(select count(*) from ${junction} where ${owned} and ${target} = any(${list}::text[])) = ${out.param(ids.length)}`);
      return;
    }
    case "size": {
      const { compare, count } = condition.value as SizeFilter;
      out.key += `:${compare}`;
      out.emit(`(select count(*) from ${junction} where ${owned}) ${COMPARISONS[compare]} ${out.param(count)}`);
      return;
    }
    case "isEmpty":
      out.key += condition.value ? ":1" : ":0";
      out.emit(`${condition.value ? "not exists" : "exists"} (select 1 from ${junction} where ${owned})`);
      return;
    default:
      throw new Error(`Operator ${condition.op} is not supported on reference arrays`);
  }
}

function translateField(out: Translation, condition: FieldCondition): void {
  const column = out.target.column(condition.field);
  if (!column) throw new Error(`Unknown column for field "${condition.field}"`);
  const target = `${out.target.table}.${column.name}`;
  const { op, value } = condition;
  out.key += `${condition.field}:${op}`;
  const comparison = COMPARISONS[op];
  if (comparison) {
    out.emit(`${target} ${comparison} ${out.param(encodeValue(column.kind, value))}`);
    return;
  }
  switch (op) {
    case "in":
      out.emit(`${target} = any(${out.param(arrayLiteral(value as unknown[]))}::${column.type}[])`);
      return;
    case "nin":
      out.emit(`${target} <> all(${out.param(arrayLiteral(value as unknown[]))}::${column.type}[])`);
      return;
    case "contains":
      out.emit(`${target} ilike ${out.param(`%${escapeLike(String(value))}%`)} escape '\\'`);
      return;
    case "startsWith":
      out.emit(`${target} ilike ${out.param(`${escapeLike(String(value))}%`)} escape '\\'`);
      return;
    case "exists":
    case "isNull": {
      const missing = op === "isNull" ? Boolean(value) : !value;
      out.key += missing ? ":1" : ":0";
      out.emit(`${target} ${missing ? "is null" : "is not null"}`);
      return;
    }
    default:
      throw new Error(`Operator ${op} only applies to reference arrays`);
  }
}

function translate(out: Translation, condition: Condition): void {
  if (isConditionGroup(condition) && condition.group === "not") {
    out.key += "not(";
    // IS NOT TRUE also matches when the inner condition is NULL, as it is for comparisons with a NULL column.
    out.emit("(");
    if (condition.conditions.length === 0) out.emit("(1 = 1)");
    else translateAll(out, condition.conditions, " and ");
    out.emit(" is not true)");
    out.key += ")";
    return;
  }
  if (isConditionGroup(condition)) {
    const or = condition.group === "or";
    out.key += or ? "or(" : "and(";
    // An empty AND matches everything; an empty OR matches nothing.
    if (condition.conditions.length === 0) out.emit(or ? "1 = 0" : "1 = 1");
    else translateAll(out, condition.conditions, or ? " or " : " and ");
    out.key += ")";
    return;
  }
  const junction = out.target.junction(condition.field);
  if (junction) translateRelation(out, junction, condition);
  else translateField(out, condition);
}

function translateAll(out: Translation, conditions: readonly Condition[], separator: string): void {
  out.emit("(");
  conditions.forEach((condition, index) => {
    if (index > 0) {
      out.key += ",";
      out.emit(separator);
    }
    translate(out, condition);
  });
  out.emit(")");
}

/**
 * Translates conditions (combined with AND) into the text of a WHERE clause, without the `where` keyword, and its
 * parameters, numbered from `firstParam`. Values are only ever parameters; `contains` and `startsWith` match literally
 * and ignore case. The key identifies the shape (fields, operators and groups, without the values), so callers can
 * cache the text by it and pass `withText: false` once it is cached. Without conditions the text is empty.
 */
export function compileConditions(conditions: readonly Condition[], target: ConditionTarget, firstParam = 1, withText = true): CompiledConditions {
  const out = new Translation(target, firstParam, withText);
  if (conditions.length > 0) translateAll(out, conditions, " and ");
  return { key: out.key, params: out.params, text: out.parts?.join("") };
}

/** The ORDER BY list of `sort` and its shape key. */
export function compileSort(sort: readonly SortField[], target: ConditionTarget): { key: string; text: string } {
  const terms = sort.map(({ field, direction }) => {
    const column = target.column(field);
    if (!column) throw new Error(`Unknown column for field "${field}"`);
    return `${target.table}.${column.name} ${direction}`;
  });
  return { key: sort.map(({ field, direction }) => `${field}:${direction}`).join(","), text: terms.join(", ") };
}
