// Query string handling for the list and read routes: populate, fields, filters, sorting and paging,
// with the error messages of the contract. Filters, sorting and paging become SQL.
import { HttpError } from "./errors.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_LIST_VALUES = 100;

/** Every operator name the API knows; a field accepts a subset of them. */
const OPERATORS = new Set(["eq", "ne", "in", "nin", "gt", "gte", "lt", "lte", "contains", "startsWith", "exists", "isNull", "containsAny", "containsAll", "size", "isEmpty"]);
const EQUALITY = ["eq", "ne", "in", "nin"];
const ORDERED = [...EQUALITY, "gt", "gte", "lt", "lte"];
const COMPARISON_SQL = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };

const ROLES = ["member", "admin"];

/**
 * A collection's query surface. `fields` maps API names to columns (null for computed fields), `sortable` lists the
 * sortable names, and `filters` gives each filterable field its type and operators.
 */
export const USERS = {
  table: "users",
  fields: { id: "id", createdAt: "created_at", updatedAt: "updated_at", email: "email", name: "name", role: "role", age: "age" },
  sortable: new Set(["id", "createdAt", "updatedAt", "email", "name", "role", "age"]),
  filters: {
    email: { type: "string", operators: EQUALITY },
    role: { type: "enum", values: ROLES, operators: EQUALITY },
    age: { type: "number", operators: ORDERED },
  },
  populatable: new Set(),
};

export const ORGANIZATIONS = {
  table: "organizations",
  fields: { id: "id", createdAt: "created_at", updatedAt: "updated_at", name: "name", slug: "slug", members: null },
  sortable: new Set(["id", "createdAt", "updatedAt", "name", "slug"]),
  filters: {
    slug: { type: "string", operators: EQUALITY },
  },
  populatable: new Set(["members"]),
};

const first = (value) => (Array.isArray(value) ? value[0] : value);

/** The `populate` parameter: whether the collection's references are populated. Throws on paths it cannot populate. */
export function parsePopulate(collection, query) {
  const raw = first(query.populate);
  if (raw === undefined) return false;
  const paths = raw.split(",").map((path) => path.trim()).filter((path) => path !== "");
  const details = [];
  for (const path of paths) {
    if (!collection.populatable.has(path)) details.push({ field: "populate", message: `Cannot populate: ${path}` });
  }
  if (details.length > 0) throw new HttpError(400, details[0].message, details);
  return paths.length > 0;
}

/** The `fields` parameter: the selected field names, or undefined for every field. */
export function parseFields(collection, query) {
  const raw = first(query.fields);
  if (raw === undefined) return undefined;
  const entries = [...new Set(raw.split(",").map((entry) => entry.trim()).filter((entry) => entry !== ""))];
  if (entries.length === 0) throw new HttpError(400, "Invalid query", [{ field: "fields", message: "Must list at least one field" }]);
  const unknown = entries.filter((name) => !Object.hasOwn(collection.fields, name));
  if (unknown.length > 0) throw new HttpError(400, "Invalid query", unknown.map((name) => ({ field: "fields", message: `Unknown field: ${name}` })));
  return entries;
}

const WHERE_KEY = /^where\[([^\]]+)\]\[([^\]]+)\]$/;

function convert(raw, filter) {
  if (filter.type === "number") {
    const value = raw.trim() === "" ? Number.NaN : Number(raw);
    return Number.isFinite(value) ? { value } : { error: "Must be a number" };
  }
  if (filter.type === "enum") return filter.values.includes(raw) ? { value: raw } : { error: `Must be one of: ${filter.values.join(", ")}` };
  return { value: raw };
}

/** Adds the SQL condition of one `where[field][op]` parameter to `where`, or its error to `details`. */
function parseCondition(collection, name, op, raw, param, where, values, details) {
  if (!Object.hasOwn(collection.filters, name)) return details.push({ field: param, message: `Field "${name}" cannot be filtered` });
  if (!OPERATORS.has(op)) return details.push({ field: param, message: `Unknown operator "${op}"` });
  const filter = collection.filters[name];
  if (!filter.operators.includes(op)) return details.push({ field: param, message: `Operator "${op}" is not allowed for this field` });
  const column = `"${collection.fields[name]}"`;

  if (op === "in" || op === "nin") {
    const items = raw.split(",").map((item) => item.trim()).filter((item) => item !== "");
    if (items.length === 0) return details.push({ field: param, message: "Must list at least one value" });
    if (items.length > MAX_LIST_VALUES) return details.push({ field: param, message: `Must list at most ${MAX_LIST_VALUES} values` });
    const converted = [];
    for (const item of items) {
      const result = convert(item, filter);
      if (result.error) return details.push({ field: param, message: result.error });
      converted.push(result.value);
    }
    values.push(converted);
    const cast = filter.type === "number" ? "float8[]" : "text[]";
    where.push(op === "in" ? `${column} = ANY($${values.length}::${cast})` : `NOT (${column} = ANY($${values.length}::${cast}))`);
    return;
  }

  const result = convert(raw, filter);
  if (result.error) return details.push({ field: param, message: result.error });
  values.push(result.value);
  where.push(`${column} ${COMPARISON_SQL[op]} $${values.length}`);
}

function parseSort(collection, raw, details) {
  const order = [];
  const seen = new Set();
  if (raw === undefined) {
    order.push(`"created_at" DESC`);
    seen.add("createdAt");
  } else {
    for (const part of raw.split(",").map((item) => item.trim())) {
      const descending = part.startsWith("-");
      const name = descending ? part.slice(1) : part;
      if (!collection.sortable.has(name)) {
        details.push({ field: "sort", message: `Field "${name}" cannot be sorted` });
        continue;
      }
      if (seen.has(name)) {
        details.push({ field: "sort", message: `Field "${name}" is listed more than once` });
        continue;
      }
      seen.add(name);
      order.push(`"${collection.fields[name]}" ${descending ? "DESC" : "ASC"}`);
    }
  }
  // The tie-breaker keeps pages stable.
  if (!seen.has("id")) order.push(`"id" DESC`);
  return order.join(", ");
}

function parseInteger(raw, name, min, max, fallback, details) {
  if (raw === undefined) return fallback;
  const value = /^-?\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value < min || value > max) {
    details.push({ field: name, message: max === Number.MAX_SAFE_INTEGER ? `Must be an integer of at least ${min}` : `Must be an integer from ${min} to ${max}` });
    return fallback;
  }
  return value;
}

/**
 * The list parameters: `where` (SQL conditions joined with AND, using `values` as $1..$n), `orderBy`, `limit` and
 * `offset`. All problems are reported together as 400 Invalid query.
 */
export function parseListQuery(collection, query) {
  const details = [];
  const where = [];
  const values = [];
  const single = {};
  for (const key of Object.keys(query)) {
    let raw = query[key];
    if (Array.isArray(raw)) {
      details.push({ field: key, message: "Parameter is repeated" });
      raw = raw[0];
    }
    const match = WHERE_KEY.exec(key);
    if (match) parseCondition(collection, match[1], match[2], raw, key, where, values, details);
    else if (key === "sort" || key === "limit" || key === "offset") single[key] = raw;
    else if (key !== "fields" && key !== "populate") details.push({ field: key, message: "Unknown parameter" });
  }
  const orderBy = parseSort(collection, single.sort, details);
  const limit = parseInteger(single.limit, "limit", 1, MAX_LIMIT, DEFAULT_LIMIT, details);
  const offset = parseInteger(single.offset, "offset", 0, Number.MAX_SAFE_INTEGER, 0, details);
  if (details.length > 0) throw new HttpError(400, "Invalid query", details);
  return { where: where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "", values, orderBy, limit, offset };
}
