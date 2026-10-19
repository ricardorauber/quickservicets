// List query parsing (limit, offset, sort, where[field][op], fields, populate) and the SQL it turns into.
import { HttpError, invalidQuery } from "./errors.js";

export const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const MAX_LIST_VALUES = 100;

const KNOWN_OPERATORS = new Set([
  "eq", "ne", "in", "nin", "gt", "gte", "lt", "lte", "contains", "startsWith", "exists", "isNull", "containsAny", "containsAll", "size", "isEmpty",
]);
const EQUALITY = ["eq", "ne", "in", "nin"];
const OPERATORS_BY_TYPE = {
  id: EQUALITY,
  string: EQUALITY,
  enum: EQUALITY,
  number: [...EQUALITY, "gt", "gte", "lt", "lte"],
  date: [...EQUALITY, "gt", "gte", "lt", "lte"],
};
const SQL_OPERATORS = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };
const WHERE_KEY = /^where\[([^\]]+)\]\[([^\]]+)\]$/;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;
const LIST_PARAMS = new Set(["limit", "offset", "sort", "fields", "populate"]);

/** Converts one query string value to the field's type, or returns the error message. */
function convert(raw, field) {
  switch (field.type) {
    case "number": {
      const value = raw.trim() === "" ? Number.NaN : Number(raw);
      return Number.isFinite(value) ? { value } : { error: "Must be a number" };
    }
    case "date":
      return ISO_8601.test(raw) && !Number.isNaN(Date.parse(raw)) ? { value: new Date(raw) } : { error: "Must be an ISO 8601 date" };
    case "enum":
      return field.values.includes(raw) ? { value: raw } : { error: `Must be one of: ${field.values.join(", ")}` };
    default:
      return { value: raw };
  }
}

/** One `where[name][op]=raw` condition as SQL, or undefined after recording the problem. */
function condition(entity, name, op, raw, param, details, values) {
  const field = entity.fields[name];
  if (!field || !field.column) return void details.push({ field: param, message: `Field "${name}" cannot be filtered` });
  if (!KNOWN_OPERATORS.has(op)) return void details.push({ field: param, message: `Unknown operator "${op}"` });
  if (!OPERATORS_BY_TYPE[field.type].includes(op)) {
    return void details.push({ field: param, message: `Operator "${op}" is not allowed for this field` });
  }
  if (op === "in" || op === "nin") {
    const items = raw.split(",").map((item) => item.trim()).filter((item) => item !== "");
    if (items.length === 0) return void details.push({ field: param, message: "Must list at least one value" });
    if (items.length > MAX_LIST_VALUES) return void details.push({ field: param, message: `Must list at most ${MAX_LIST_VALUES} values` });
    const converted = [];
    for (const item of items) {
      const result = convert(item, field);
      if (result.error) return void details.push({ field: param, message: result.error });
      converted.push(result.value);
    }
    values.push(converted);
    return op === "in" ? `"${field.column}" = ANY($${values.length})` : `"${field.column}" <> ALL($${values.length})`;
  }
  const result = convert(raw, field);
  if (result.error) return void details.push({ field: param, message: result.error });
  values.push(result.value);
  return `"${field.column}" ${SQL_OPERATORS[op]} $${values.length}`;
}

function parseSort(entity, raw, details) {
  const items = [];
  const seen = new Set();
  for (const part of (raw ?? "-createdAt").split(",").map((item) => item.trim())) {
    const descending = part.startsWith("-");
    const name = descending ? part.slice(1) : part;
    const field = entity.fields[name];
    if (!field || !field.column) {
      details.push({ field: "sort", message: `Field "${name}" cannot be sorted` });
      continue;
    }
    if (seen.has(name)) {
      details.push({ field: "sort", message: `Field "${name}" is listed more than once` });
      continue;
    }
    seen.add(name);
    items.push(`"${field.column}" ${descending ? "DESC" : "ASC"}`);
  }
  if (!seen.has("id")) items.push(`"id" DESC`);
  return items.join(", ");
}

function parseInteger(raw, name, min, max, fallback, details) {
  if (raw === undefined) return fallback;
  const value = /^-?\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    details.push({ field: name, message: max === Number.MAX_SAFE_INTEGER ? `Must be an integer of at least ${min}` : `Must be an integer from ${min} to ${max}` });
    return fallback;
  }
  return value;
}

/** The `fields` parameter: the selected field names, or undefined for every field. */
function parseFields(entity, raw, details) {
  if (raw === undefined) return undefined;
  const names = [...new Set(raw.split(",").map((item) => item.trim()).filter((item) => item !== ""))];
  if (names.length === 0) {
    details.push({ field: "fields", message: "Must list at least one field" });
    return undefined;
  }
  const unknown = names.filter((name) => !(name in entity.fields));
  for (const name of unknown) details.push({ field: "fields", message: `Unknown field: ${name}` });
  return unknown.length > 0 ? undefined : names;
}

/** The `populate` parameter; invalid paths fail on their own, before the rest of the query is checked. */
function parsePopulate(entity, raw) {
  if (raw === undefined) return false;
  const paths = raw.split(",").map((item) => item.trim()).filter((item) => item !== "");
  const details = paths.filter((path) => !entity.populate.includes(path)).map((path) => ({ field: "populate", message: `Cannot populate: ${path}` }));
  if (details.length > 0) throw new HttpError(400, details[0].message, details);
  return paths.length > 0;
}

const first = (value) => (Array.isArray(value) ? value[0] : value);

/** Query of a read route (`GET /<collection>/{id}`): only `fields` and `populate` matter. */
export function parseReadQuery(entity, query) {
  const populate = parsePopulate(entity, first(query.populate));
  const details = [];
  const fields = parseFields(entity, first(query.fields), details);
  if (details.length > 0) throw invalidQuery(details);
  return { fields, populate };
}

/**
 * Query of a list route. Returns the selected fields, whether to populate, and the SQL pieces: `where` (with its
 * `values`), `orderBy`, `limit` and `offset`.
 */
export function parseListQuery(entity, query) {
  const populate = parsePopulate(entity, first(query.populate));
  const details = [];
  const conditions = [];
  const values = [];
  const single = {};
  for (const key of Object.keys(query)) {
    const raw = query[key];
    if (Array.isArray(raw)) {
      details.push({ field: key, message: "Parameter is repeated" });
      continue;
    }
    const match = WHERE_KEY.exec(key);
    if (match) {
      const sql = condition(entity, match[1], match[2], raw, key, details, values);
      if (sql) conditions.push(sql);
    } else if (LIST_PARAMS.has(key)) {
      single[key] = raw;
    } else {
      details.push({ field: key, message: "Unknown parameter" });
    }
  }
  const fields = parseFields(entity, single.fields, details);
  const orderBy = parseSort(entity, single.sort, details);
  const limit = parseInteger(single.limit, "limit", 1, MAX_LIMIT, DEFAULT_LIMIT, details);
  const offset = parseInteger(single.offset, "offset", 0, Number.MAX_SAFE_INTEGER, 0, details);
  if (details.length > 0) throw invalidQuery(details);
  return { fields, populate, where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "", values, orderBy, limit, offset };
}

/** The columns to read for a selection (always including `id`, which the members lookup needs). */
export function columnsFor(entity, fields) {
  const names = fields ?? Object.keys(entity.fields);
  const columns = new Set(["id"]);
  for (const name of names) {
    const column = entity.fields[name].column;
    if (column) columns.add(column);
  }
  return [...columns].map((column) => `"${column}"`).join(", ");
}
