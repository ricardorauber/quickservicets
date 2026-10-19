/**
 * One worker process of the plain Bun stack: Bun.serve routes and the built-in Bun.sql PostgreSQL client.
 * The launcher (launcher.ts) starts two of these on the same port with `reusePort`.
 */
import { SQL, randomUUIDv7 } from "bun";
import { unlink } from "node:fs/promises";
import { extname } from "node:path";

// ---------------------------------------------------------------------------------------------------------------
// Configuration

const env = process.env;
const PORT = Number(env.PORT ?? 8080);
const UPLOAD_DIR = (env.UPLOAD_DIR ?? "uploads").replace(/\/+$/, "");
const POOL_SIZE = Number(env.WORKER_POOL_SIZE ?? env.DB_POOL_SIZE ?? 10);
const DATABASE_URL =
  env.DATABASE_URL ??
  `postgres://${encodeURIComponent(env.DB_USER ?? "bench")}:${encodeURIComponent(env.DB_PASSWORD ?? "bench")}@${env.DB_HOST ?? "localhost"}:${env.DB_PORT ?? "55432"}/${env.DB_NAME ?? "bench"}`;

const sql = new SQL({ url: DATABASE_URL, max: POOL_SIZE, idleTimeout: 0 });

// ---------------------------------------------------------------------------------------------------------------
// Responses

type Detail = { field: string; message: string };

const CODES: Record<number, string> = {
  400: "VALIDATION_ERROR",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  500: "INTERNAL_ERROR",
};

function fail(status: number, message: string, details?: Detail[]): Response {
  const error = details === undefined ? { code: CODES[status], message } : { code: CODES[status], message, details };
  return Response.json({ error }, { status });
}

const ok = (body: unknown, status = 200) => Response.json(body, { status });
const invalidQuery = (details: Detail[]) => fail(400, "Invalid query", details);
const invalidBody = (details: Detail[]) => fail(400, "Invalid body", details);
const notFound = (message: string) => fail(404, message);
const conflict = () => fail(409, "Value already exists", [{ field: "email", message: "Value already exists" }]);
const isUniqueViolation = (error: unknown) => (error as { errno?: string } | null)?.errno === "23505";

const EMPTY_PARAMS = new URLSearchParams();
function searchParams(req: Request): URLSearchParams {
  const url = req.url;
  const index = url.indexOf("?");
  return index === -1 ? EMPTY_PARAMS : new URLSearchParams(url.slice(index + 1));
}

// ---------------------------------------------------------------------------------------------------------------
// Entities: API field name -> column, filter type, and the SELECT expression that aliases the column to the field.

type FieldType = "id" | "date" | "string" | "enum" | "number";
type Field = { column: string; type: FieldType; select: string };
type Entity = {
  table: string;
  fields: Record<string, Field>;
  /** Fields that `fields=` may name: the columns plus computed ones such as `members`. */
  selectable: Set<string>;
  /** Reference arrays that `populate=` accepts. */
  populatable: Set<string>;
};

const ROLES = ["member", "admin"];
const ROLE_MESSAGE = "Must be one of: member, admin";

function entity(table: string, columns: Record<string, [string, FieldType]>, computed: string[] = [], populatable: string[] = []): Entity {
  const fields: Record<string, Field> = {};
  for (const [name, [column, type]] of Object.entries(columns)) {
    fields[name] = { column, type, select: column === name ? `t.${column}` : `t.${column} AS "${name}"` };
  }
  return { table, fields, selectable: new Set([...Object.keys(columns), ...computed]), populatable: new Set(populatable) };
}

const USERS = entity("users", {
  id: ["id", "id"],
  createdAt: ["created_at", "date"],
  updatedAt: ["updated_at", "date"],
  email: ["email", "string"],
  name: ["name", "string"],
  role: ["role", "enum"],
  age: ["age", "number"],
});

const ORGANIZATIONS = entity(
  "organizations",
  {
    id: ["id", "id"],
    createdAt: ["created_at", "date"],
    updatedAt: ["updated_at", "date"],
    name: ["name", "string"],
    slug: ["slug", "string"],
  },
  ["members"],
  ["members"],
);

const USER_COLUMNS = Object.values(USERS.fields)
  .map((field) => field.select)
  .join(", ");
const ORG_COLUMNS = Object.values(ORGANIZATIONS.fields)
  .map((field) => field.select)
  .join(", ");
const MEMBER_IDS = `COALESCE((SELECT array_agg(m.target_id ORDER BY m.position) FROM organizations__members m WHERE m.owner_id = t.id), '{}') AS members`;

// ---------------------------------------------------------------------------------------------------------------
// Query strings: filters, sort, paging, field selection and populate (CONTRACT.md section 5).

const FILTER_OPERATORS = new Set(["eq", "ne", "in", "nin", "gt", "gte", "lt", "lte", "contains", "startsWith", "exists", "isNull", "containsAny", "containsAll", "size", "isEmpty"]);
const BASE_OPERATORS = ["eq", "ne", "in", "nin"];
const OPERATORS_BY_TYPE: Record<FieldType, Set<string>> = {
  id: new Set(BASE_OPERATORS),
  string: new Set(BASE_OPERATORS),
  enum: new Set(BASE_OPERATORS),
  number: new Set([...BASE_OPERATORS, "gt", "gte", "lt", "lte"]),
  date: new Set([...BASE_OPERATORS, "gt", "gte", "lt", "lte"]),
};
const COMPARISONS: Record<string, string> = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };
const WHERE_KEY = /^where\[([^\]]+)\]\[([^\]]+)\]$/;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;
const MAX_LIST_VALUES = 100;

/** Converts one filter value to the field's type, or returns the error message. */
function convert(raw: string, type: FieldType): { value: unknown } | { error: string } {
  switch (type) {
    case "number": {
      const value = raw.trim() === "" ? Number.NaN : Number(raw);
      return Number.isFinite(value) ? { value } : { error: "Must be a number" };
    }
    case "enum":
      return ROLES.includes(raw) ? { value: raw } : { error: ROLE_MESSAGE };
    case "date":
      return ISO_8601.test(raw) && !Number.isNaN(Date.parse(raw)) ? { value: new Date(raw) } : { error: "Must be an ISO 8601 date" };
    default:
      return { value: raw };
  }
}

/** Appends one `where[field][op]` condition to `conditions`/`args`, or a problem to `details`. */
function addCondition(ent: Entity, name: string, op: string, raw: string, param: string, conditions: string[], args: unknown[], details: Detail[]): void {
  const field = ent.fields[name];
  if (!field) return void details.push({ field: param, message: `Field "${name}" cannot be filtered` });
  if (!FILTER_OPERATORS.has(op)) return void details.push({ field: param, message: `Unknown operator "${op}"` });
  if (!OPERATORS_BY_TYPE[field.type].has(op)) return void details.push({ field: param, message: `Operator "${op}" is not allowed for this field` });
  const column = `t.${field.column}`;
  if (op === "in" || op === "nin") {
    const items = raw
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "");
    if (items.length === 0) return void details.push({ field: param, message: "Must list at least one value" });
    if (items.length > MAX_LIST_VALUES) return void details.push({ field: param, message: `Must list at most ${MAX_LIST_VALUES} values` });
    const placeholders: string[] = [];
    for (const item of items) {
      const converted = convert(item, field.type);
      if ("error" in converted) return void details.push({ field: param, message: converted.error });
      args.push(converted.value);
      placeholders.push(`$${args.length}`);
    }
    conditions.push(`${column} ${op === "in" ? "IN" : "NOT IN"} (${placeholders.join(", ")})`);
    return;
  }
  const converted = convert(raw, field.type);
  if ("error" in converted) return void details.push({ field: param, message: converted.error });
  args.push(converted.value);
  conditions.push(`${column} ${COMPARISONS[op]} $${args.length}`);
}

function parseOrderBy(ent: Entity, raw: string | undefined, details: Detail[]): string {
  if (raw === undefined) return "t.created_at DESC, t.id DESC";
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const item = part.trim();
    const descending = item.startsWith("-");
    const name = descending ? item.slice(1) : item;
    const field = ent.fields[name];
    if (!field) {
      details.push({ field: "sort", message: `Field "${name}" cannot be sorted` });
      continue;
    }
    if (seen.has(name)) {
      details.push({ field: "sort", message: `Field "${name}" is listed more than once` });
      continue;
    }
    seen.add(name);
    terms.push(`t.${field.column} ${descending ? "DESC" : "ASC"}`);
  }
  if (!seen.has("id")) terms.push("t.id DESC");
  return terms.join(", ");
}

function parseInteger(raw: string | undefined, name: string, min: number, max: number, fallback: number, details: Detail[]): number {
  if (raw === undefined) return fallback;
  const value = /^-?\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value < min || value > max) {
    details.push({ field: name, message: max === Number.MAX_SAFE_INTEGER ? `Must be an integer of at least ${min}` : `Must be an integer from ${min} to ${max}` });
    return fallback;
  }
  return value;
}

/** `fields=`: the selected field names, or undefined for every field. */
function parseFields(ent: Entity, raw: string | null | undefined, details: Detail[]): string[] | undefined {
  if (raw === null || raw === undefined) return undefined;
  const names = [
    ...new Set(
      raw
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== ""),
    ),
  ];
  if (names.length === 0) {
    details.push({ field: "fields", message: "Must list at least one field" });
    return undefined;
  }
  for (const name of names) if (!ent.selectable.has(name)) details.push({ field: "fields", message: `Unknown field: ${name}` });
  return names;
}

/** `populate=`: whether `members` is populated, or the 400 response for a path that is not a reference. */
function parsePopulate(ent: Entity, raw: string | null | undefined): boolean | Response {
  if (raw === null || raw === undefined) return false;
  const paths = raw
    .split(",")
    .map((path) => path.trim())
    .filter((path) => path !== "");
  const details = paths.filter((path) => !ent.populatable.has(path)).map((path) => ({ field: "populate", message: `Cannot populate: ${path}` }));
  if (details.length > 0) return fail(400, details[0]!.message, details);
  return paths.length > 0;
}

type ListQuery = { where: string; args: unknown[]; orderBy: string; limit: number; offset: number; fields?: string[]; populate: boolean };

function parseListQuery(ent: Entity, params: URLSearchParams): ListQuery | Response {
  const details: Detail[] = [];
  const conditions: string[] = [];
  const args: unknown[] = [];
  const seen = new Set<string>();
  let sort: string | undefined;
  let limit: string | undefined;
  let offset: string | undefined;
  let fields: string | undefined;
  let populate: string | undefined;
  for (const [key, raw] of params) {
    if (seen.has(key)) {
      details.push({ field: key, message: "Parameter is repeated" });
      continue;
    }
    seen.add(key);
    switch (key) {
      case "sort":
        sort = raw;
        break;
      case "limit":
        limit = raw;
        break;
      case "offset":
        offset = raw;
        break;
      case "fields":
        fields = raw;
        break;
      case "populate":
        populate = raw;
        break;
      default: {
        const match = WHERE_KEY.exec(key);
        if (match) addCondition(ent, match[1]!, match[2]!, raw, key, conditions, args, details);
        else details.push({ field: key, message: "Unknown parameter" });
      }
    }
  }
  const orderBy = parseOrderBy(ent, sort, details);
  const query: ListQuery = {
    where: conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`,
    args,
    orderBy,
    limit: parseInteger(limit, "limit", 1, 100, 20, details),
    offset: parseInteger(offset, "offset", 0, Number.MAX_SAFE_INTEGER, 0, details),
    fields: parseFields(ent, fields, details),
    populate: false,
  };
  if (details.length > 0) return invalidQuery(details);
  const populated = parsePopulate(ent, populate);
  if (populated instanceof Response) return populated;
  query.populate = populated;
  return query;
}

/** The SELECT list for a field selection (every column when there is none). */
function selectList(ent: Entity, all: string, fields: string[] | undefined): string {
  if (!fields) return all;
  const parts: string[] = [];
  for (const name of fields) {
    const field = ent.fields[name];
    if (field) parts.push(field.select);
  }
  return parts.join(", ");
}

// ---------------------------------------------------------------------------------------------------------------
// Users

async function listUsers(req: Request): Promise<Response> {
  const query = parseListQuery(USERS, searchParams(req));
  if (query instanceof Response) return query;
  const { where, args, orderBy, limit, offset, fields } = query;
  const n = args.length;
  const [data, count] = await Promise.all([
    sql.unsafe(`SELECT ${selectList(USERS, USER_COLUMNS, fields)} FROM users t${where} ORDER BY ${orderBy} LIMIT $${n + 1} OFFSET $${n + 2}`, [...args, limit, offset]),
    sql.unsafe(`SELECT count(*)::int AS total FROM users t${where}`, args),
  ]);
  return ok({ data, total: count[0].total, limit, offset });
}

/** `fields` (and `populate`, which users reject) on a read route; other parameters are ignored. */
function readSelection(ent: Entity, req: Request): { fields?: string[]; populate: boolean } | Response {
  const params = searchParams(req);
  if (params.size === 0) return { populate: false };
  const details: Detail[] = [];
  const fields = parseFields(ent, params.get("fields"), details);
  if (details.length > 0) return invalidQuery(details);
  const populate = parsePopulate(ent, params.get("populate"));
  if (populate instanceof Response) return populate;
  return { fields, populate };
}

async function getUser(req: Bun.BunRequest<"/users/:id">): Promise<Response> {
  const selection = readSelection(USERS, req);
  if (selection instanceof Response) return selection;
  const rows = await sql.unsafe(`SELECT ${selectList(USERS, USER_COLUMNS, selection.fields)} FROM users t WHERE t.id = $1`, [req.params.id]);
  return rows.length === 0 ? notFound("User not found") : ok(rows[0]);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const READ_ONLY = new Set(["id", "createdAt", "updatedAt"]);
type UserInput = { email?: string; name?: string; role?: string; age?: number | null };

/** Parses a JSON object body, or returns the 400 response. */
async function readObject(req: Request): Promise<Record<string, unknown> | Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return invalidBody([{ field: "", message: "Body must be a JSON object" }]);
  return body as Record<string, unknown>;
}

/** Validates a user body (CONTRACT.md section 6); on create, `email` and `name` are required. */
function validateUser(body: Record<string, unknown>, creating: boolean): UserInput | Response {
  const details: Detail[] = [];
  const input: UserInput = {};

  if (!Object.hasOwn(body, "email")) {
    if (creating) details.push({ field: "email", message: "Is required" });
  } else {
    const email = body.email;
    if (email === null) details.push({ field: "email", message: "Cannot be null" });
    else if (typeof email !== "string") details.push({ field: "email", message: "Must be a string" });
    else if (!EMAIL.test(email)) details.push({ field: "email", message: "Must be a valid email" });
    else input.email = email;
  }

  if (!Object.hasOwn(body, "name")) {
    if (creating) details.push({ field: "name", message: "Is required" });
  } else {
    const name = body.name;
    if (name === null) details.push({ field: "name", message: "Cannot be null" });
    else if (typeof name !== "string") details.push({ field: "name", message: "Must be a string" });
    else if (name.length < 1) details.push({ field: "name", message: "Must be at least 1 characters" });
    else if (name.length > 100) details.push({ field: "name", message: "Must be at most 100 characters" });
    else input.name = name;
  }

  if (Object.hasOwn(body, "role")) {
    const role = body.role;
    if (role === null) details.push({ field: "role", message: "Cannot be null" });
    else if (typeof role !== "string" || !ROLES.includes(role)) details.push({ field: "role", message: ROLE_MESSAGE });
    else input.role = role;
  }

  if (Object.hasOwn(body, "age")) {
    const age = body.age;
    if (age === null) input.age = null;
    else if (typeof age !== "number") details.push({ field: "age", message: "Must be a number" });
    else if (!Number.isInteger(age)) details.push({ field: "age", message: "Must be an integer" });
    else if (age < 0) details.push({ field: "age", message: "Must be at least 0" });
    else if (age > 150) details.push({ field: "age", message: "Must be at most 150" });
    else input.age = age;
  }

  for (const key of Object.keys(body)) {
    if (key === "email" || key === "name" || key === "role" || key === "age") continue;
    details.push({ field: key, message: READ_ONLY.has(key) ? "Field is read-only" : "Unknown field" });
  }

  return details.length > 0 ? invalidBody(details) : input;
}

async function createUser(req: Request): Promise<Response> {
  const body = await readObject(req);
  if (body instanceof Response) return body;
  const input = validateUser(body, true);
  if (input instanceof Response) return input;
  const id = randomUUIDv7();
  const now = new Date();
  const user = { id, createdAt: now, updatedAt: now, email: input.email!, name: input.name!, role: input.role ?? "member", age: input.age ?? null };
  try {
    await sql`INSERT INTO users (id, created_at, updated_at, email, name, role, age)
              VALUES (${id}, ${now}, ${now}, ${user.email}, ${user.name}, ${user.role}, ${user.age})`;
  } catch (error) {
    if (isUniqueViolation(error)) return conflict();
    throw error;
  }
  return ok(user, 201);
}

async function updateUser(req: Bun.BunRequest<"/users/:id">): Promise<Response> {
  const body = await readObject(req);
  if (body instanceof Response) return body;
  const input = validateUser(body, false);
  if (input instanceof Response) return input;
  const args: unknown[] = [req.params.id, new Date()];
  let set = "updated_at = $2";
  for (const [name, value] of Object.entries(input)) {
    args.push(value);
    set += `, ${name} = $${args.length}`;
  }
  let rows;
  try {
    rows = await sql.unsafe(`UPDATE users t SET ${set} WHERE t.id = $1 RETURNING ${USER_COLUMNS}`, args);
  } catch (error) {
    if (isUniqueViolation(error)) return conflict();
    throw error;
  }
  return rows.length === 0 ? notFound("User not found") : ok(rows[0]);
}

async function deleteUser(req: Bun.BunRequest<"/users/:id">): Promise<Response> {
  // One statement, so one transaction: delete the user (the junction rows cascade) and touch the organizations
  // that listed it. Every CTE sees the snapshot from before the delete, so the junction rows are still visible.
  const id = req.params.id;
  const rows = await sql`
    WITH deleted AS (DELETE FROM users WHERE id = ${id} RETURNING id),
    touched AS (
      UPDATE organizations SET updated_at = ${new Date()}
      WHERE id IN (SELECT owner_id FROM organizations__members WHERE target_id IN (SELECT id FROM deleted))
    )
    SELECT count(*)::int AS deleted FROM deleted`;
  return rows[0].deleted === 0 ? notFound("User not found") : new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------------------------------------------
// Organizations

const POPULATED_MEMBERS = `SELECT m.owner_id AS "ownerId", ${USER_COLUMNS.replaceAll("t.", "u.")}
  FROM organizations__members m JOIN users u ON u.id = m.target_id`;

type Row = Record<string, any>;

/** Loads the member records of the given organizations, in position order, keyed by organization id. */
async function membersOf(ownerIds: string[]): Promise<Map<string, Row[]>> {
  const byOwner = new Map<string, Row[]>();
  if (ownerIds.length === 0) return byOwner;
  for (const id of ownerIds) byOwner.set(id, []);
  const placeholders = ownerIds.map((_, index) => `$${index + 1}`).join(", ");
  const rows = await sql.unsafe(`${POPULATED_MEMBERS} WHERE m.owner_id IN (${placeholders}) ORDER BY m.owner_id, m.position`, ownerIds);
  for (const row of rows) {
    byOwner.get(row.ownerId)!.push({ id: row.id, createdAt: row.createdAt, updatedAt: row.updatedAt, email: row.email, name: row.name, role: row.role, age: row.age });
  }
  return byOwner;
}

/**
 * The SELECT list of an organization query. Member ids come from an array_agg subquery; with populate, the id is
 * selected (as `__id` when the client did not ask for it) so the members can be attached afterwards.
 */
function orgSelect(fields: string[] | undefined, populate: boolean): { columns: string; attach: boolean; hiddenId: boolean } {
  const wantsMembers = !fields || fields.includes("members");
  const attach = populate && wantsMembers;
  const parts = [selectList(ORGANIZATIONS, ORG_COLUMNS, fields)].filter((part) => part !== "");
  const hiddenId = attach && fields !== undefined && !fields.includes("id");
  if (hiddenId) parts.push(`t.id AS "__id"`);
  if (wantsMembers && !attach) parts.push(MEMBER_IDS);
  return { columns: parts.join(", "), attach, hiddenId };
}

async function attachMembers(rows: Row[], hiddenId: boolean): Promise<Row[]> {
  const key = hiddenId ? "__id" : "id";
  const members = await membersOf(rows.map((row) => row[key]));
  return rows.map((row) => {
    const { __id, ...rest } = row;
    rest.members = members.get(row[key]) ?? [];
    return rest;
  });
}

async function listOrganizations(req: Request): Promise<Response> {
  const query = parseListQuery(ORGANIZATIONS, searchParams(req));
  if (query instanceof Response) return query;
  const { where, args, orderBy, limit, offset, fields, populate } = query;
  const { columns, attach, hiddenId } = orgSelect(fields, populate);
  const n = args.length;
  const [rows, count] = await Promise.all([
    sql.unsafe(`SELECT ${columns} FROM organizations t${where} ORDER BY ${orderBy} LIMIT $${n + 1} OFFSET $${n + 2}`, [...args, limit, offset]),
    sql.unsafe(`SELECT count(*)::int AS total FROM organizations t${where}`, args),
  ]);
  const data = attach ? await attachMembers(rows, hiddenId) : rows;
  return ok({ data, total: count[0].total, limit, offset });
}

async function getOrganization(req: Bun.BunRequest<"/organizations/:id">): Promise<Response> {
  const selection = readSelection(ORGANIZATIONS, req);
  if (selection instanceof Response) return selection;
  const { columns, attach, hiddenId } = orgSelect(selection.fields, selection.populate);
  const id = req.params.id;
  const select = sql.unsafe(`SELECT ${columns} FROM organizations t WHERE t.id = $1`, [id]);
  if (!attach) {
    const rows = await select;
    return rows.length === 0 ? notFound("Organization not found") : ok(rows[0]);
  }
  const [rows, members] = await Promise.all([select, membersOf([id])]);
  if (rows.length === 0) return notFound("Organization not found");
  const { __id, ...organization } = rows[0];
  organization.members = members.get(id) ?? [];
  return ok(organization);
}

async function organizationStats(req: Bun.BunRequest<"/organizations/:orgId/stats">): Promise<Response> {
  const rows = await sql`
    SELECT count(u.id)::int AS members,
           (count(*) FILTER (WHERE u.role = 'admin'))::int AS admins,
           avg(u.age) AS "averageAge"
    FROM organizations o
    LEFT JOIN organizations__members m ON m.owner_id = o.id
    LEFT JOIN users u ON u.id = m.target_id
    WHERE o.id = ${req.params.orgId}
    GROUP BY o.id`;
  return rows.length === 0 ? notFound("Organization not found") : ok(rows[0]);
}

// ---------------------------------------------------------------------------------------------------------------
// Media (CONTRACT.md section 7)

const MAX_UPLOAD = 1024 * 1024;
const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg"]);
const MEDIA_READ_ONLY = new Set(["id", "createdAt", "updatedAt", "filename", "mimeType", "size", "storage", "url"]);
const MEDIA_COLUMNS = `id, created_at AS "createdAt", updated_at AS "updatedAt", filename, mime_type AS "mimeType", size, storage`;

/** The type recognized from the leading bytes, if any. */
function detectType(b: Uint8Array): string | undefined {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "image/gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return "application/pdf";
  return undefined;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
// eslint-disable-next-line no-control-regex
const DISPOSITION_UNSAFE = /["\\\u0000-\u001f]/g;

const mediaRecord = (row: Row) => ({ ...row, url: `/media/${row.id}/file` });

type Part = { name: string; filename?: string; type?: string; data: Buffer };

const CRLF = Buffer.from("\r\n");
const HEADERS_END = Buffer.from("\r\n\r\n");
const BOUNDARY = /boundary=(?:"([^"]+)"|([^;\s]+))/i;
const PART_NAME = /(?:^|;)\s*name=(?:"([^"]*)"|([^;\s]+))/i;
const PART_FILENAME = /(?:^|;)\s*filename=(?:"([^"]*)"|([^;\s]+))/i;
const PART_FILENAME_EXT = /(?:^|;)\s*filename\*=(?:[^']*)'[^']*'([^;\s]+)/i;

/**
 * Splits a multipart/form-data body into its parts in one pass. Hand-written because Bun's `formData()` derives a
 * file part's type from its file name instead of the part's Content-Type header, which the upload rules depend on.
 * Returns undefined for a malformed body.
 */
function parseMultipart(body: Buffer, contentType: string): Part[] | undefined {
  const boundary = BOUNDARY.exec(contentType);
  if (!boundary) return undefined;
  const delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  const next = Buffer.from(`\r\n--${boundary[1] ?? boundary[2]}`);
  const parts: Part[] = [];
  let position = body.indexOf(delimiter);
  if (position === -1) return undefined;
  for (;;) {
    position += delimiter.length;
    if (body[position] === 0x2d && body[position + 1] === 0x2d) return parts;
    const headersStart = body.indexOf(CRLF, position);
    if (headersStart === -1) return undefined;
    const headersEnd = body.indexOf(HEADERS_END, headersStart);
    if (headersEnd === -1) return undefined;
    const dataStart = headersEnd + HEADERS_END.length;
    const dataEnd = body.indexOf(next, dataStart);
    if (dataEnd === -1) return undefined;
    let name: string | undefined;
    let filename: string | undefined;
    let type: string | undefined;
    for (const line of body.toString("utf8", headersStart + CRLF.length, headersEnd).split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const header = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (header === "content-type") type = value;
      else if (header === "content-disposition") {
        const nameMatch = PART_NAME.exec(value);
        name = nameMatch ? (nameMatch[1] ?? nameMatch[2]) : undefined;
        const extended = PART_FILENAME_EXT.exec(value);
        const plain = PART_FILENAME.exec(value);
        if (extended) {
          try {
            filename = decodeURIComponent(extended[1]!);
          } catch {
            filename = extended[1];
          }
        } else if (plain) filename = plain[1] ?? plain[2];
      }
    }
    if (name !== undefined) parts.push({ name, filename, type, data: body.subarray(dataStart, dataEnd) });
    position = dataEnd + CRLF.length;
  }
}

async function uploadMedia(req: Request): Promise<Response> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) return fail(415, "Must be multipart/form-data");
  const parts = parseMultipart(Buffer.from(await req.arrayBuffer()), contentType);
  if (!parts) return fail(400, "Invalid multipart body");
  const file = parts.find((part) => part.name === "file" && part.filename !== undefined);
  if (!file) return invalidBody([{ field: "file", message: "Is required" }]);

  const data = file.data;
  const declared = (file.type ?? "").split(";")[0]!.trim().toLowerCase();
  const detected = detectType(data);
  let mimeType = declared;
  if (detected) {
    if (declared !== "" && declared !== "application/octet-stream" && declared !== detected) {
      return fail(415, "File content does not match its type", [{ field: "file", message: `Detected ${detected}, declared ${declared}` }]);
    }
    mimeType = detected;
  }
  if (data.length > MAX_UPLOAD) return fail(413, "File too large");
  if (!ACCEPTED_TYPES.has(mimeType)) return invalidBody([{ field: "file", message: "File type not allowed" }]);

  const details: Detail[] = [];
  const reported = new Set<string>();
  for (const { name } of parts) {
    if (name === "file" || reported.has(name)) continue;
    reported.add(name);
    details.push({ field: name, message: MEDIA_READ_ONLY.has(name) ? "Field is read-only" : "Unknown field" });
  }
  if (details.length > 0) return invalidBody(details);

  const rawName = file.filename!;
  const filename = rawName
    .slice(Math.max(rawName.lastIndexOf("/"), rawName.lastIndexOf("\\")) + 1)
    .replace(CONTROL, "")
    .slice(0, 255);
  const id = randomUUIDv7();
  const storageKey = `media/${id}/${randomUUIDv7()}${extname(filename).toLowerCase()}`;
  const path = `${UPLOAD_DIR}/${storageKey}`;
  const now = new Date();
  const size = data.length;
  await Bun.write(path, data);
  try {
    await sql`INSERT INTO media (id, created_at, updated_at, filename, mime_type, size, storage, storage_key)
              VALUES (${id}, ${now}, ${now}, ${filename}, ${mimeType}, ${size}, 'default', ${storageKey})`;
  } catch (error) {
    await unlink(path).catch(() => {});
    throw error;
  }
  return ok({ id, createdAt: now, updatedAt: now, filename, mimeType, size, storage: "default", url: `/media/${id}/file` }, 201);
}

async function getMedia(req: Bun.BunRequest<"/media/:id">): Promise<Response> {
  const rows = await sql.unsafe(`SELECT ${MEDIA_COLUMNS} FROM media WHERE id = $1`, [req.params.id]);
  return rows.length === 0 ? notFound("Media not found") : ok(mediaRecord(rows[0]));
}

async function getMediaFile(req: Bun.BunRequest<"/media/:id/file">): Promise<Response> {
  const rows = await sql`SELECT filename, mime_type, size, storage_key FROM media WHERE id = ${req.params.id}`;
  if (rows.length === 0) return notFound("Media not found");
  const { filename, mime_type, size, storage_key } = rows[0];
  const file = Bun.file(`${UPLOAD_DIR}/${storage_key}`);
  if (!(await file.exists())) return notFound("Media not found");
  return new Response(file, {
    headers: {
      "content-type": mime_type,
      "content-length": String(size),
      "content-disposition": `inline; filename="${String(filename).replace(DISPOSITION_UNSAFE, "")}"`,
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Server

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  reusePort: true,
  development: false,
  routes: {
    "/health": { GET: () => Response.json({ ok: true }) },
    "/users": { GET: listUsers, POST: createUser },
    "/users/:id": { GET: getUser, PATCH: updateUser, DELETE: deleteUser },
    "/organizations": { GET: listOrganizations },
    "/organizations/:id": { GET: getOrganization },
    "/organizations/:orgId/stats": { GET: organizationStats },
    "/media": { POST: uploadMedia },
    "/media/:id": { GET: getMedia },
    "/media/:id/file": { GET: getMediaFile },
  },
  fetch: () => notFound("Route not found"),
  error: (error) => {
    console.error(error);
    return fail(500, "Internal server error");
  },
});

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(0), 8_000).unref();
  await server.stop();
  await sql.close({ timeout: 5 });
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
