import { Router } from "express";
import { v7 as uuidv7 } from "uuid";
import { pool, rows, UNIQUE_VIOLATION } from "./db.js";
import { ROLES, User, USER_COLUMNS, present, presentUser } from "./entities.js";
import { HttpError, invalidBody, notFound } from "./errors.js";
import { columnsFor, parseListQuery, parseReadQuery } from "./query.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const READ_ONLY = new Set(["id", "createdAt", "updatedAt"]);

const string = (value) => (typeof value === "string" ? undefined : "Must be a string");
const RULES = {
  email: (value) => string(value) ?? (EMAIL.test(value) ? undefined : "Must be a valid email"),
  name: (value) =>
    string(value) ?? (value.length < 1 ? "Must be at least 1 characters" : value.length > 100 ? "Must be at most 100 characters" : undefined),
  role: (value) => (ROLES.includes(value) ? undefined : "Must be one of: member, admin"),
  age: (value) => {
    if (typeof value !== "number") return "Must be a number";
    if (!Number.isInteger(value)) return "Must be an integer";
    if (value < 0) return "Must be at least 0";
    if (value > 150) return "Must be at most 150";
    return undefined;
  },
};
const NULLABLE = new Set(["age"]);
const REQUIRED_ON_CREATE = ["email", "name"];

/** Validates a create (`partial` false) or update body and returns it; every problem is reported together. */
function validateUser(body, partial) {
  if (body === undefined) throw new HttpError(400, "Invalid JSON body");
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw invalidBody([{ field: "", message: "Body must be a JSON object" }]);
  }
  const details = [];
  for (const [field, rule] of Object.entries(RULES)) {
    if (!Object.hasOwn(body, field)) {
      if (!partial && REQUIRED_ON_CREATE.includes(field)) details.push({ field, message: "Is required" });
      continue;
    }
    const value = body[field];
    const message = value === null ? (NULLABLE.has(field) ? undefined : "Cannot be null") : rule(value);
    if (message) details.push({ field, message });
  }
  for (const key of Object.keys(body)) {
    if (READ_ONLY.has(key)) details.push({ field: key, message: "Field is read-only" });
    else if (!Object.hasOwn(RULES, key)) details.push({ field: key, message: "Unknown field" });
  }
  if (details.length > 0) throw invalidBody(details);
  return body;
}

const emailTaken = () =>
  new HttpError(409, "Value already exists", [{ field: "email", message: "Value already exists" }]);

/** Runs a write, turning a violation of the unique email index into a 409. */
async function guardEmail(write) {
  try {
    return await write();
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION && err.constraint === "users_email_uq") throw emailTaken();
    throw err;
  }
}

const COLUMN_OF = { email: "email", name: "name", role: "role", age: "age" };

export const users = Router();

users.get("/", async (req, res) => {
  const q = parseListQuery(User, req.query);
  const n = q.values.length;
  const [data, count] = await Promise.all([
    rows(`SELECT ${columnsFor(User, q.fields)} FROM "users" ${q.where} ORDER BY ${q.orderBy} LIMIT $${n + 1} OFFSET $${n + 2}`, [
      ...q.values,
      q.limit,
      q.offset,
    ]),
    rows(`SELECT count(*)::int AS "total" FROM "users" ${q.where}`, q.values),
  ]);
  res.json({ data: data.map((row) => present(User, row, q.fields)), total: count[0].total, limit: q.limit, offset: q.offset });
});

users.get("/:id", async (req, res) => {
  const { fields } = parseReadQuery(User, req.query);
  const [row] = await rows(`SELECT ${USER_COLUMNS} FROM "users" WHERE "id" = $1`, [req.params.id], "user_by_id");
  if (!row) throw notFound("User");
  res.json(present(User, row, fields));
});

users.post("/", async (req, res) => {
  const body = validateUser(req.body, false);
  const now = new Date();
  const user = { id: uuidv7(), createdAt: now, updatedAt: now, email: body.email, name: body.name, role: body.role ?? "member", age: body.age ?? null };
  await guardEmail(() =>
    rows(
      `INSERT INTO "users" (${USER_COLUMNS}) VALUES ($1, $2, $2, $3, $4, $5, $6)`,
      [user.id, now, user.email, user.name, user.role, user.age],
      "user_insert",
    ),
  );
  res.status(201).json({ ...user, createdAt: now.toISOString(), updatedAt: now.toISOString() });
});

users.patch("/:id", async (req, res) => {
  const body = validateUser(req.body, true);
  const values = [req.params.id, new Date()];
  const sets = [`"updated_at" = $2`];
  for (const [field, column] of Object.entries(COLUMN_OF)) {
    if (!Object.hasOwn(body, field)) continue;
    values.push(body[field]);
    sets.push(`"${column}" = $${values.length}`);
  }
  const [row] = await guardEmail(() => rows(`UPDATE "users" SET ${sets.join(", ")} WHERE "id" = $1 RETURNING ${USER_COLUMNS}`, values));
  if (!row) throw notFound("User");
  res.json(presentUser(row));
});

// One statement, so one transaction: the organizations that list the user get a new updatedAt, then the
// membership rows go with the user through the foreign key's ON DELETE CASCADE.
const DELETE_USER = `
  WITH "deleted" AS (DELETE FROM "users" WHERE "id" = $1 RETURNING "id"),
  "touched" AS (
    UPDATE "organizations" SET "updated_at" = $2
    WHERE "id" IN (SELECT "owner_id" FROM "organizations__members" WHERE "target_id" = $1) AND EXISTS (SELECT 1 FROM "deleted")
  )
  SELECT count(*)::int AS "deleted" FROM "deleted"`;

users.delete("/:id", async (req, res) => {
  const result = await pool.query({ name: "user_delete", text: DELETE_USER, values: [req.params.id, new Date()] });
  if (result.rows[0].deleted === 0) throw notFound("User");
  res.status(204).end();
});
