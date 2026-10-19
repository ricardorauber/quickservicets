import { Router } from "express";
import { rows } from "./db.js";
import { Organization, present, presentUser } from "./entities.js";
import { notFound } from "./errors.js";
import { columnsFor, parseListQuery, parseReadQuery } from "./query.js";

const MEMBER_IDS = `
  SELECT "owner_id", "target_id" FROM "organizations__members"
  WHERE "owner_id" = ANY($1) ORDER BY "owner_id", "position"`;
const MEMBER_USERS = `
  SELECT m."owner_id", u."id", u."created_at", u."updated_at", u."email", u."name", u."role", u."age"
  FROM "organizations__members" m JOIN "users" u ON u."id" = m."target_id"
  WHERE m."owner_id" = ANY($1) ORDER BY m."owner_id", m."position"`;

/** Fills `members` on a page of organization rows with one query: member ids, or full users when populating. */
async function attachMembers(orgs, populate) {
  const byOwner = new Map(orgs.map((org) => [org.id, (org.members = [])]));
  if (orgs.length === 0) return;
  const ids = [...byOwner.keys()];
  if (populate) {
    for (const row of await rows(MEMBER_USERS, [ids], "org_member_users")) byOwner.get(row.owner_id).push(presentUser(row));
  } else {
    for (const row of await rows(MEMBER_IDS, [ids], "org_member_ids")) byOwner.get(row.owner_id).push(row.target_id);
  }
}

const wantsMembers = (fields) => fields === undefined || fields.includes("members");

export const organizations = Router();

organizations.get("/", async (req, res) => {
  const q = parseListQuery(Organization, req.query);
  const n = q.values.length;
  const [data, count] = await Promise.all([
    rows(`SELECT ${columnsFor(Organization, q.fields)} FROM "organizations" ${q.where} ORDER BY ${q.orderBy} LIMIT $${n + 1} OFFSET $${n + 2}`, [
      ...q.values,
      q.limit,
      q.offset,
    ]),
    rows(`SELECT count(*)::int AS "total" FROM "organizations" ${q.where}`, q.values),
  ]);
  if (wantsMembers(q.fields)) await attachMembers(data, q.populate);
  res.json({ data: data.map((row) => present(Organization, row, q.fields)), total: count[0].total, limit: q.limit, offset: q.offset });
});

organizations.get("/:id", async (req, res) => {
  const { fields, populate } = parseReadQuery(Organization, req.query);
  const found = await rows(`SELECT "id", "created_at", "updated_at", "name", "slug" FROM "organizations" WHERE "id" = $1`, [req.params.id], "org_by_id");
  if (found.length === 0) throw notFound("Organization");
  if (wantsMembers(fields)) await attachMembers(found, populate);
  res.json(present(Organization, found[0], fields));
});

// Counts and averages in SQL; no row when the organization does not exist.
const STATS = `
  SELECT s."members", s."admins", s."average_age"
  FROM "organizations" o CROSS JOIN LATERAL (
    SELECT count(*)::int AS "members", (count(*) FILTER (WHERE u."role" = 'admin'))::int AS "admins", avg(u."age") AS "average_age"
    FROM "organizations__members" m JOIN "users" u ON u."id" = m."target_id"
    WHERE m."owner_id" = o."id"
  ) s
  WHERE o."id" = $1`;

organizations.get("/:orgId/stats", async (req, res) => {
  const [row] = await rows(STATS, [req.params.orgId], "org_stats");
  if (!row) throw notFound("Organization");
  res.json({ members: row.members, admins: row.admins, averageAge: row.average_age });
});
