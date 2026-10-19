import { open } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { v7 as uuidv7 } from "uuid";
import { createPool, prepared } from "./db.js";
import { HttpError, errorBody } from "./errors.js";
import { MAX_FILE_SIZE, createMedia, mediaRecord } from "./media.js";
import { ORGANIZATIONS, USERS, parseFields, parseListQuery, parsePopulate } from "./query.js";
import { validateUser } from "./users.js";

// ---- Response schemas (compiled by fast-json-stringify) ----------------------------------------------------------

const timestamp = { type: "string", format: "date-time" };
const userSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    createdAt: timestamp,
    updatedAt: timestamp,
    email: { type: "string" },
    name: { type: "string" },
    role: { type: "string" },
    age: { type: ["number", "null"] },
  },
};
const organizationProperties = {
  id: { type: "string" },
  createdAt: timestamp,
  updatedAt: timestamp,
  name: { type: "string" },
  slug: { type: "string" },
};
const organizationSchema = { type: "object", properties: { ...organizationProperties, members: { type: "array", items: { type: "string" } } } };
const populatedOrganizationSchema = { type: "object", properties: { ...organizationProperties, members: { type: "array", items: userSchema } } };
const pageOf = (item) => ({
  type: "object",
  properties: { data: { type: "array", items: item }, total: { type: "integer" }, limit: { type: "integer" }, offset: { type: "integer" } },
});
const organizationPage = pageOf(organizationSchema);
const populatedOrganizationPage = pageOf(populatedOrganizationSchema);
const mediaSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    createdAt: timestamp,
    updatedAt: timestamp,
    filename: { type: "string" },
    mimeType: { type: "string" },
    size: { type: "number" },
    storage: { type: "string" },
    url: { type: "string" },
  },
};
const statsSchema = {
  type: "object",
  properties: { members: { type: "integer" }, admins: { type: "integer" }, averageAge: { type: ["number", "null"] } },
};

// ---- SQL -----------------------------------------------------------------------------------------------------------

const USER_COLUMNS = {
  id: `"id"`,
  createdAt: `"created_at" AS "createdAt"`,
  updatedAt: `"updated_at" AS "updatedAt"`,
  email: `"email"`,
  name: `"name"`,
  role: `"role"`,
  age: `"age"`,
};
const ALL_USER_COLUMNS = Object.values(USER_COLUMNS).join(", ");
const userColumns = (fields) => (fields ? fields.map((field) => USER_COLUMNS[field]).join(", ") : ALL_USER_COLUMNS);

const ORGANIZATION_COLUMNS = {
  createdAt: `o."created_at" AS "createdAt"`,
  updatedAt: `o."updated_at" AS "updatedAt"`,
  name: `o."name"`,
  slug: `o."slug"`,
};
const MEMBER_IDS = `ARRAY(SELECT m."target_id" FROM "organizations__members" m WHERE m."owner_id" = o."id" ORDER BY m."position") AS "members"`;
const POPULATED_MEMBERS = `SELECT m."owner_id" AS "ownerId", ${Object.values(USER_COLUMNS).map((column) => `u.${column}`).join(", ")}
  FROM "organizations__members" m JOIN "users" u ON u."id" = m."target_id"
  WHERE m."owner_id" = ANY($1::text[]) ORDER BY m."owner_id", m."position"`;

/** The select list of an organization query; the id is always read (members are matched by it). */
function organizationColumns(fields, populate) {
  const names = fields ?? Object.keys(ORGANIZATIONS.fields);
  const columns = [`o."id"`];
  for (const name of names) if (ORGANIZATION_COLUMNS[name]) columns.push(ORGANIZATION_COLUMNS[name]);
  if (names.includes("members") && !populate) columns.push(MEMBER_IDS);
  return columns.join(", ");
}

const UNIQUE_VIOLATION = "23505";
const conflict = () =>
  new HttpError(409, "Value already exists", [{ field: "email", message: "Value already exists" }]);

// ---- App -----------------------------------------------------------------------------------------------------------

export function buildApp(pool, uploadDir) {
  const app = Fastify({ logger: false, return503OnClosing: true });

  app.register(multipart, { limits: { fileSize: MAX_FILE_SIZE }, throwFileSizeLimit: false });

  const notFound = (message) => new HttpError(404, message);

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send(errorBody(404, "Route not found"));
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      reply.code(error.status).send(errorBody(error.status, error.message, error.details));
      return;
    }
    if (error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      reply.code(415).send(errorBody(415, "Unsupported media type"));
      return;
    }
    if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      reply.code(413).send(errorBody(413, "Payload too large"));
      return;
    }
    // Body parser errors (empty body, syntax errors, prototype poisoning) carry a 400 status.
    if (error.statusCode === 400 && (error.code?.startsWith("FST_ERR_CTP_") || error instanceof SyntaxError)) {
      reply.code(400).send(errorBody(400, "Invalid JSON body"));
      return;
    }
    if (typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
      reply.code(error.statusCode).send(errorBody(error.statusCode, error.message));
      return;
    }
    console.error(error);
    reply.code(500).send(errorBody(500, "Internal server error"));
  });

  app.get("/health", { schema: { response: { 200: { type: "object", properties: { ok: { type: "boolean" } } } } } }, async () => ({ ok: true }));

  // ---- Users ----

  app.get("/users", { schema: { response: { 200: pageOf(userSchema) } } }, async (request) => {
    parsePopulate(USERS, request.query);
    const fields = parseFields(USERS, request.query);
    const { where, values, orderBy, limit, offset } = parseListQuery(USERS, request.query);
    const n = values.length;
    const [rows, count] = await Promise.all([
      pool.query(prepared(`SELECT ${userColumns(fields)} FROM "users"${where} ORDER BY ${orderBy} LIMIT $${n + 1} OFFSET $${n + 2}`, [...values, limit, offset])),
      pool.query(prepared(`SELECT count(*)::int AS "total" FROM "users"${where}`, values)),
    ]);
    return { data: rows.rows, total: count.rows[0].total, limit, offset };
  });

  app.get("/users/:id", { schema: { response: { 200: userSchema } } }, async (request) => {
    const fields = parseFields(USERS, request.query);
    const { rows } = await pool.query(prepared(`SELECT ${userColumns(fields)} FROM "users" WHERE "id" = $1`, [request.params.id]));
    if (rows.length === 0) throw notFound("User not found");
    return rows[0];
  });

  app.post("/users", { schema: { response: { 201: userSchema } } }, async (request, reply) => {
    const data = validateUser(request.body, true);
    const now = new Date();
    const user = { id: uuidv7(), createdAt: now, updatedAt: now, email: data.email, name: data.name, role: data.role ?? "member", age: data.age ?? null };
    try {
      await pool.query({
        name: "user_insert",
        text: `INSERT INTO "users" ("id", "created_at", "updated_at", "email", "name", "role", "age") VALUES ($1, $2, $2, $3, $4, $5, $6)`,
        values: [user.id, now, user.email, user.name, user.role, user.age],
      });
    } catch (error) {
      if (error.code === UNIQUE_VIOLATION && error.constraint === "users_email_uq") throw conflict();
      throw error;
    }
    reply.code(201);
    return user;
  });

  app.patch("/users/:id", { schema: { response: { 200: userSchema } } }, async (request) => {
    const data = validateUser(request.body, false);
    const values = [request.params.id];
    const sets = [];
    for (const field of ["email", "name", "role", "age"]) {
      if (!(field in data)) continue;
      values.push(data[field]);
      sets.push(`"${field}" = $${values.length}`);
    }
    values.push(new Date());
    sets.push(`"updated_at" = $${values.length}`);
    let rows;
    try {
      ({ rows } = await pool.query(prepared(`UPDATE "users" SET ${sets.join(", ")} WHERE "id" = $1 RETURNING ${ALL_USER_COLUMNS}`, values)));
    } catch (error) {
      if (error.code === UNIQUE_VIOLATION && error.constraint === "users_email_uq") throw conflict();
      throw error;
    }
    if (rows.length === 0) throw notFound("User not found");
    return rows[0];
  });

  app.delete("/users/:id", async (request, reply) => {
    // One statement, so one transaction: delete the user (its memberships cascade) and touch its organizations.
    const { rowCount } = await pool.query({
      name: "user_delete",
      text: `WITH deleted AS (DELETE FROM "users" WHERE "id" = $1 RETURNING "id"),
        touched AS (
          UPDATE "organizations" SET "updated_at" = $2
          WHERE "id" IN (SELECT m."owner_id" FROM "organizations__members" m WHERE m."target_id" IN (SELECT "id" FROM deleted))
        )
        SELECT 1 FROM deleted`,
      values: [request.params.id, new Date()],
    });
    if (rowCount === 0) throw notFound("User not found");
    return reply.code(204).send();
  });

  // ---- Organizations ----

  /** Replaces each organization's members with the user records, in position order, with one query. */
  async function populateMembers(organizations) {
    const byOwner = new Map(organizations.map((organization) => [organization.id, (organization.members = [])]));
    if (organizations.length === 0) return;
    const { rows } = await pool.query({ name: "members_populated", text: POPULATED_MEMBERS, values: [[...byOwner.keys()]] });
    for (const { ownerId, ...user } of rows) byOwner.get(ownerId).push(user);
  }

  const project = (record, fields) => {
    const result = {};
    for (const field of fields) result[field] = record[field];
    return result;
  };

  async function readOrganizations(sql, values, fields, populate) {
    const { rows } = await pool.query(prepared(sql, values));
    if (populate && (!fields || fields.includes("members"))) await populateMembers(rows);
    return fields ? rows.map((row) => project(row, fields)) : rows;
  }

  app.get("/organizations", { schema: { response: { 200: organizationPage } } }, async (request, reply) => {
    const populate = parsePopulate(ORGANIZATIONS, request.query);
    const fields = parseFields(ORGANIZATIONS, request.query);
    const { where, values, orderBy, limit, offset } = parseListQuery(ORGANIZATIONS, request.query);
    const n = values.length;
    const sql = `SELECT ${organizationColumns(fields, populate)} FROM "organizations" o${where} ORDER BY ${orderBy} LIMIT $${n + 1} OFFSET $${n + 2}`;
    const [data, count] = await Promise.all([
      readOrganizations(sql, [...values, limit, offset], fields, populate),
      pool.query(prepared(`SELECT count(*)::int AS "total" FROM "organizations" o${where}`, values)),
    ]);
    if (populate) reply.type("application/json; charset=utf-8").serializer(reply.compileSerializationSchema(populatedOrganizationPage));
    return { data, total: count.rows[0].total, limit, offset };
  });

  app.get("/organizations/:id", { schema: { response: { 200: organizationSchema } } }, async (request, reply) => {
    const populate = parsePopulate(ORGANIZATIONS, request.query);
    const fields = parseFields(ORGANIZATIONS, request.query);
    const sql = `SELECT ${organizationColumns(fields, populate)} FROM "organizations" o WHERE o."id" = $1`;
    const [organization] = await readOrganizations(sql, [request.params.id], fields, populate);
    if (!organization) throw notFound("Organization not found");
    if (populate) reply.type("application/json; charset=utf-8").serializer(reply.compileSerializationSchema(populatedOrganizationSchema));
    return organization;
  });

  app.get("/organizations/:id/stats", { schema: { response: { 200: statsSchema } } }, async (request) => {
    const { rows } = await pool.query({
      name: "organization_stats",
      text: `SELECT count(u."id")::int AS "members",
          (count(*) FILTER (WHERE u."role" = 'admin'))::int AS "admins",
          avg(u."age") AS "averageAge"
        FROM "organizations" o
        LEFT JOIN "organizations__members" m ON m."owner_id" = o."id"
        LEFT JOIN "users" u ON u."id" = m."target_id"
        WHERE o."id" = $1
        GROUP BY o."id"`,
      values: [request.params.id],
    });
    if (rows.length === 0) throw notFound("Organization not found");
    return rows[0];
  });

  // ---- Media ----

  app.post(
    "/media",
    {
      schema: { response: { 201: mediaSchema } },
      // Reject anything but multipart before a body parser runs.
      preParsing: async (request) => {
        if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("multipart/form-data")) {
          throw new HttpError(415, "Must be multipart/form-data");
        }
      },
    },
    async (request, reply) => {
      const record = await createMedia(request, pool, uploadDir);
      reply.code(201);
      return record;
    },
  );

  const MEDIA_COLUMNS = `"id", "created_at" AS "createdAt", "updated_at" AS "updatedAt", "filename", "mime_type" AS "mimeType", "size"`;

  app.get("/media/:id", { schema: { response: { 200: mediaSchema } } }, async (request) => {
    const { rows } = await pool.query({ name: "media_read", text: `SELECT ${MEDIA_COLUMNS} FROM "media" WHERE "id" = $1`, values: [request.params.id] });
    if (rows.length === 0) throw notFound("Media not found");
    return mediaRecord(rows[0]);
  });

  app.get("/media/:id/file", async (request, reply) => {
    const { rows } = await pool.query({
      name: "media_file",
      text: `SELECT "filename", "mime_type" AS "mimeType", "size", "storage_key" AS "storageKey" FROM "media" WHERE "id" = $1`,
      values: [request.params.id],
    });
    if (rows.length === 0) throw notFound("Media not found");
    const { filename, mimeType, size, storageKey } = rows[0];
    let handle;
    try {
      handle = await open(path.join(uploadDir, storageKey));
    } catch (error) {
      if (error.code === "ENOENT") throw notFound("Media not found");
      throw error;
    }
    reply.headers({
      "content-type": mimeType,
      "content-length": size,
      "content-disposition": `inline; filename="${String(filename).replace(/["\\\u0000-\u001f]/g, "")}"`,
    });
    return reply.send(handle.createReadStream());
  });

  return app;
}

export async function start(workers) {
  const pool = createPool(workers);
  const uploadDir = process.env.UPLOAD_DIR ?? path.resolve("uploads");
  const app = buildApp(pool, uploadDir);
  await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 8080) });

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => process.exit(0), 8000).unref();
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
