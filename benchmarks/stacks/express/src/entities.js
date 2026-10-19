// The three collections: their fields, columns, query types and JSON shape.

const iso = (date) => date.toISOString();

const systemFields = {
  id: { column: "id", type: "id", read: (row) => row.id },
  createdAt: { column: "created_at", type: "date", read: (row) => iso(row.created_at) },
  updatedAt: { column: "updated_at", type: "date", read: (row) => iso(row.updated_at) },
};

export const ROLES = ["member", "admin"];

export const User = {
  name: "User",
  table: "users",
  populate: [],
  fields: {
    ...systemFields,
    email: { column: "email", type: "string", read: (row) => row.email },
    name: { column: "name", type: "string", read: (row) => row.name },
    role: { column: "role", type: "enum", values: ROLES, read: (row) => row.role },
    age: { column: "age", type: "number", read: (row) => row.age },
  },
};

export const Organization = {
  name: "Organization",
  table: "organizations",
  populate: ["members"],
  fields: {
    ...systemFields,
    name: { column: "name", type: "string", read: (row) => row.name },
    slug: { column: "slug", type: "string", read: (row) => row.slug },
    // A reference array stored in organizations__members: selectable, not sortable or filterable here.
    members: { read: (row) => row.members },
  },
};

export const USER_COLUMNS = `"id", "created_at", "updated_at", "email", "name", "role", "age"`;

/** The full user record. */
export const presentUser = (row) => ({
  id: row.id,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  email: row.email,
  name: row.name,
  role: row.role,
  age: row.age,
});

/** A record restricted to `fields` (every field when undefined). */
export function present(entity, row, fields) {
  if (fields === undefined) {
    if (entity === User) return presentUser(row);
    fields = Object.keys(entity.fields);
  }
  const out = {};
  for (const name of fields) out[name] = entity.fields[name].read(row);
  return out;
}
