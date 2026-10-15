import { HttpError, type FieldErrorDetail } from "./errors.ts";
import type { EntityModel } from "./model.ts";

export const FILTER_OPERATORS = [
  "eq",
  "ne",
  "in",
  "nin",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "startsWith",
  "exists",
  "isNull",
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export interface Condition {
  field: string;
  op: FilterOperator;
  value: unknown;
  /** Set for `contains`/`startsWith`: compare ignoring case and treat the value literally (no wildcards). */
  caseInsensitive?: true;
  literal?: true;
}

export type SortDirection = "asc" | "desc";

export interface SortField {
  field: string;
  direction: SortDirection;
}

export interface ListQuery {
  where: Condition[];
  sort: SortField[];
  limit: number;
  offset: number;
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const MAX_LIST_VALUES = 100;

type QueryFieldType = "id" | "string" | "number" | "boolean" | "date" | "enum" | "ref";

interface QueryField {
  type: QueryFieldType;
  values?: string[];
}

const COMMON_OPERATORS: FilterOperator[] = ["eq", "ne", "in", "nin", "exists", "isNull"];
const OPERATORS_BY_TYPE: Record<QueryFieldType, FilterOperator[]> = {
  id: COMMON_OPERATORS,
  ref: COMMON_OPERATORS,
  boolean: COMMON_OPERATORS,
  enum: COMMON_OPERATORS,
  string: [...COMMON_OPERATORS, "contains", "startsWith"],
  number: [...COMMON_OPERATORS, "gt", "gte", "lt", "lte"],
  date: [...COMMON_OPERATORS, "gt", "gte", "lt", "lte"],
};

const ISO_8601 = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;
const WHERE_KEY = /^where\[([^\]]+)\]\[([^\]]+)\]$/;

/** Fields that list routes can filter and sort by: system and column fields exposed by the list operation. */
export function queryableFields(model: EntityModel): Map<string, QueryField> {
  const { include, exclude } = model.exposure.list;
  const exposed = (name: string) =>
    include.some((path) => path === name || path.startsWith(`${name}.`)) &&
    !exclude.some((path) => path === name);
  const fields = new Map<string, QueryField>();
  for (const [name, type] of [["id", "id"], ["createdAt", "date"], ["updatedAt", "date"]] as const) {
    if (exposed(name)) fields.set(name, { type });
  }
  for (const field of model.fields) {
    if (field.storage !== "column" || field.hidden || !exposed(field.name)) continue;
    if (field.type === "enum") fields.set(field.name, { type: "enum", values: field.values });
    else if (field.type !== "array" && field.type !== "object") fields.set(field.name, { type: field.type });
  }
  return fields;
}

class QueryErrors {
  readonly details: FieldErrorDetail[] = [];
  add(field: string, message: string): undefined {
    this.details.push({ field, message });
    return undefined;
  }
}

function coerce(raw: string, field: QueryField, param: string, errors: QueryErrors): unknown {
  switch (field.type) {
    case "number": {
      const value = raw.trim() === "" ? Number.NaN : Number(raw);
      return Number.isFinite(value) ? value : errors.add(param, "Must be a number");
    }
    case "boolean":
      if (raw === "true") return true;
      if (raw === "false") return false;
      return errors.add(param, "Must be true or false");
    case "date":
      return ISO_8601.test(raw) && !Number.isNaN(Date.parse(raw))
        ? new Date(raw)
        : errors.add(param, "Must be an ISO 8601 date");
    case "enum":
      return field.values?.includes(raw) ? raw : errors.add(param, `Must be one of: ${field.values?.join(", ")}`);
    default:
      return raw;
  }
}

function parseCondition(
  name: string,
  op: string,
  raw: string,
  param: string,
  fields: Map<string, QueryField>,
  errors: QueryErrors,
): Condition | undefined {
  const field = fields.get(name);
  if (!field) return errors.add(param, `Field "${name}" cannot be filtered`);
  if (!(FILTER_OPERATORS as readonly string[]).includes(op)) return errors.add(param, `Unknown operator "${op}"`);
  const operator = op as FilterOperator;
  if (!OPERATORS_BY_TYPE[field.type].includes(operator)) {
    return errors.add(param, `Operator "${op}" is not allowed for this field`);
  }

  if (operator === "exists" || operator === "isNull") {
    if (raw !== "true" && raw !== "false") return errors.add(param, "Must be true or false");
    return { field: name, op: operator, value: raw === "true" };
  }
  if (operator === "in" || operator === "nin") {
    const items = raw.split(",").map((item) => item.trim()).filter((item) => item !== "");
    if (items.length === 0) return errors.add(param, "Must list at least one value");
    if (items.length > MAX_LIST_VALUES) return errors.add(param, `Must list at most ${MAX_LIST_VALUES} values`);
    const before = errors.details.length;
    const values = items.map((item) => coerce(item, field, param, errors));
    return errors.details.length > before ? undefined : { field: name, op: operator, value: values };
  }
  const before = errors.details.length;
  const value = coerce(raw, field, param, errors);
  if (errors.details.length > before) return undefined;
  if (operator === "contains" || operator === "startsWith") {
    return { field: name, op: operator, value, caseInsensitive: true, literal: true };
  }
  return { field: name, op: operator, value };
}

function parseSort(raw: string | undefined, fields: Map<string, QueryField>, errors: QueryErrors): SortField[] {
  const sort: SortField[] = [];
  if (raw === undefined) {
    sort.push({ field: "createdAt", direction: "desc" });
  } else {
    for (const part of raw.split(",").map((item) => item.trim())) {
      const descending = part.startsWith("-");
      const name = descending ? part.slice(1) : part;
      if (!fields.has(name)) {
        errors.add("sort", `Field "${name}" cannot be sorted`);
        continue;
      }
      if (sort.some((existing) => existing.field === name)) {
        errors.add("sort", `Field "${name}" is listed more than once`);
        continue;
      }
      sort.push({ field: name, direction: descending ? "desc" : "asc" });
    }
  }
  if (!sort.some((item) => item.field === "id")) sort.push({ field: "id", direction: "desc" });
  return sort;
}

function parseInteger(raw: string | undefined, name: string, min: number, max: number, fallback: number, errors: QueryErrors): number {
  if (raw === undefined) return fallback;
  const value = /^-?\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value < min || value > max) {
    errors.add(name, max === Number.MAX_SAFE_INTEGER ? `Must be an integer of at least ${min}` : `Must be an integer from ${min} to ${max}`);
    return fallback;
  }
  return value;
}

export function parseListQuery(model: EntityModel, params: URLSearchParams): ListQuery {
  const errors = new QueryErrors();
  const fields = queryableFields(model);
  const where: Condition[] = [];
  const seen = new Set<string>();
  const single = new Map<string, string>();

  for (const [key, raw] of params) {
    if (seen.has(key)) {
      errors.add(key, "Parameter is repeated");
      continue;
    }
    seen.add(key);
    const match = WHERE_KEY.exec(key);
    if (match) {
      const condition = parseCondition(match[1]!, match[2]!, raw, key, fields, errors);
      if (condition) where.push(condition);
    } else if (["sort", "limit", "offset"].includes(key)) {
      single.set(key, raw);
    } else if (key === "fields" || key === "exclude" || key === "populate") {
      // Field selection and population are validated separately (see parseClientSelection and populate).
    } else {
      errors.add(key, "Unknown parameter");
    }
  }

  const sort = parseSort(single.get("sort"), fields, errors);
  const limit = parseInteger(single.get("limit"), "limit", 1, MAX_LIMIT, DEFAULT_LIMIT, errors);
  const offset = parseInteger(single.get("offset"), "offset", 0, Number.MAX_SAFE_INTEGER, 0, errors);

  if (errors.details.length > 0) {
    throw new HttpError(400, "Invalid query", { details: errors.details });
  }
  return { where, sort, limit, offset };
}
