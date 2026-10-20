/**
 * End-to-end tests of every route of this project, with every outcome each one can produce.
 * Runs the generated app in-process on an in-memory database: `bun test` in examples/identity.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, localStorage, memoryAdapter, resolveConfig } from "@quickservice/core";

const root = join(import.meta.dir, "..");
type Json = Record<string, any>;
// The body is any JSON value: an object for most routes, a boolean for the permission check.
type Result = { status: number; body: any; headers: Headers };

let fetchApp: (request: Request) => Promise<Response>;

beforeAll(async () => {
  const built = Bun.spawnSync(["bun", "run", "quickservice", "build"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (built.exitCode !== 0) throw new Error(`build failed: ${built.stderr.toString()}${built.stdout.toString()}`);
  const { models } = await import(join(root, ".generated/models.ts"));
  const { crudRoutes, endpoints, hooks } = await import(join(root, ".generated/routes.ts"));
  const openApi = await Bun.file(join(root, ".generated/openapi.json")).json();
  const database = memoryAdapter();
  await database.connect(models);
  const config = resolveConfig(
    {
      database,
      populate: { maxDepth: 3 },
      storage: { default: localStorage({ dir: mkdtempSync(join(tmpdir(), "identity-uploads-")) }) },
      logger: { info() {}, warn() {}, error() {} },
    },
    {},
  );
  const { server } = createApp({ models, crudRoutes, endpoints, hooks, config, openApi });
  fetchApp = (request) => server.fetch(request);
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Result> {
  const init: RequestInit = { method, headers };
  if (body instanceof FormData) init.body = body;
  else if (typeof body === "string") init.body = body;
  else if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetchApp(new Request(`http://x${path}`, init));
  const text = await response.text();
  let parsed: Json = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { text };
  }
  return { status: response.status, body: parsed, headers: response.headers };
}
const get = (path: string) => call("GET", path);
const post = (path: string, body?: unknown, headers?: Record<string, string>) => call("POST", path, body, headers);
const patch = (path: string, body?: unknown) => call("PATCH", path, body);
const put = (path: string, body?: unknown) => call("PUT", path, body);
const del = (path: string) => call("DELETE", path);

/** Creates a record and returns it, failing the test when the response is not 201. */
async function create(path: string, body: unknown): Promise<Json> {
  const result = await post(path, body);
  if (result.status !== 201) throw new Error(`POST ${path} → ${result.status} ${JSON.stringify(result.body)}`);
  return result.body;
}
const details = (result: Result) => (result.body.error?.details ?? []) as { field: string; message: string }[];
const detail = (result: Result, field: string) => details(result).find((item) => item.field === field)?.message;
const MISSING = "01a10000-0000-7000-8000-000000000000";
let counter = 0;
const unique = (prefix: string) => `${prefix}-${++counter}`;

const png = (bytes = 8, name = "pic.png", type = "image/png") => new File([new Uint8Array(bytes)], name, { type });
const form = (entries: [string, string | Blob][]) => {
  const body = new FormData();
  for (const [key, value] of entries) body.append(key, value);
  return body;
};

/** A complete, valid graph of records to reference from the tests. */
async function world() {
  const billing = await create("/modules", { slug: unique("billing"), active: true });
  const reports = await create("/modules", { slug: unique("reports"), active: true });
  const legacy = await create("/modules", { slug: unique("legacy"), active: false });
  const org = await create("/organizations", { slug: unique("acme"), legalName: "Acme Ltd", active: true, modules: [billing.id, reports.id, legacy.id] });
  const inactiveOrg = await create("/organizations", { slug: unique("off"), legalName: "Off Ltd", active: false });
  const billingManage = await create("/permissions", { module: billing.id, action: "manage" });
  const reportsView = await create("/permissions", { module: reports.id, action: "view" });
  const legacyManage = await create("/permissions", { module: legacy.id, action: "manage" });
  const finance = await create("/profiles", { slug: unique("finance"), permissions: [billingManage.id, legacyManage.id] });
  const analyst = await create("/profiles", { slug: unique("analyst"), permissions: [reportsView.id] });
  const ana = await create("/users", { email: `${unique("ana")}@x.co` });
  const membership = await create("/memberships", { organization: org.id, user: ana.id, profiles: [finance.id], active: true });
  const team = await create("/teams", { organization: org.id, name: "Data", users: [ana.id], profiles: [analyst.id], active: true });
  return { billing, reports, legacy, org, inactiveOrg, billingManage, reportsView, legacyManage, finance, analyst, ana, membership, team };
}

// ---------------------------------------------------------------------------------------------------------------
// Behavior shared by every generated CRUD route, checked once per entity.
// ---------------------------------------------------------------------------------------------------------------

interface CrudCase {
  path: string;
  entity: string;
  /** A valid create body (may depend on other records). */
  valid: () => Promise<Json>;
  /** A required field to leave out, and a field with a wrong type. */
  required: string;
  wrongType: [string, unknown, string];
  /** A valid PATCH body. */
  change: Json;
}

const crudCases: CrudCase[] = [
  { path: "/modules", entity: "Module", valid: async () => ({ slug: unique("m"), active: true }), required: "slug", wrongType: ["active", "yes", "Must be a boolean"], change: { active: false } },
  {
    path: "/organizations",
    entity: "Organization",
    valid: async () => ({ slug: unique("o"), legalName: "Org", active: true }),
    required: "legalName",
    wrongType: ["slug", 1, "Must be a string"],
    change: { name: "Renamed" },
  },
  {
    path: "/permissions",
    entity: "Permission",
    valid: async () => ({ module: (await create("/modules", { slug: unique("m"), active: true })).id, action: "view" }),
    required: "module",
    wrongType: ["action", "delete", "Must be one of: manage, view"],
    change: { action: "manage" },
  },
  { path: "/profiles", entity: "Profile", valid: async () => ({ slug: unique("p") }), required: "slug", wrongType: ["permissions", "x", "Must be an array"], change: { slug: unique("p2") } },
  { path: "/users", entity: "User", valid: async () => ({ email: `${unique("u")}@x.co`, role: "basic" }), required: "email", wrongType: ["role", "root", "Must be one of: admin, basic"], change: { name: "Ana" } },
  {
    path: "/memberships",
    entity: "Membership",
    valid: async () => {
      const org = await create("/organizations", { slug: unique("o"), legalName: "Org", active: true });
      const user = await create("/users", { email: `${unique("u")}@x.co` });
      return { organization: org.id, user: user.id, active: true };
    },
    required: "active",
    wrongType: ["active", 1, "Must be a boolean"],
    change: { active: false },
  },
  {
    path: "/teams",
    entity: "Team",
    valid: async () => ({ organization: (await create("/organizations", { slug: unique("o"), legalName: "Org", active: true })).id, name: "Team", active: true }),
    required: "name",
    wrongType: ["name", false, "Must be a string"],
    change: { name: "Renamed" },
  },
];

describe.each(crudCases)("$path", ({ path, entity, valid, required, wrongType, change }) => {
  test("POST creates (201) with system fields", async () => {
    const result = await post(path, await valid());
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ id: expect.any(String), createdAt: expect.any(String), updatedAt: expect.any(String) });
    expect(result.headers.get("x-request-id")).toBeTruthy();
  });

  test("POST rejects invalid bodies (400)", async () => {
    const body = await valid();
    const malformed = await post(path, "{ not json");
    expect([malformed.status, malformed.body.error.message]).toEqual([400, "Invalid JSON body"]);
    const notObject = await post(path, []);
    expect([notObject.status, detail(notObject, "")]).toEqual([400, "Body must be a JSON object"]);
    const { [required]: _, ...missing } = body;
    expect(detail(await post(path, missing), required)).toBe("Is required");
    expect(detail(await post(path, { ...body, extra: 1 }), "extra")).toBe("Unknown field");
    expect(detail(await post(path, { ...body, id: MISSING }), "id")).toBe("Field is read-only");
    expect(detail(await post(path, { ...body, [wrongType[0]]: wrongType[1] }), wrongType[0])).toBe(wrongType[2]);
  });

  test("GET list (200), with paging, sorting, filters and field selection", async () => {
    await create(path, await valid());
    const list = await get(path);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ data: expect.any(Array), total: expect.any(Number), limit: 20, offset: 0 });
    const paged = await get(`${path}?limit=1&offset=0&sort=-createdAt`);
    expect([paged.status, paged.body.data.length, paged.body.limit]).toEqual([200, 1, 1]);
    const selected = await get(`${path}?fields=id&limit=1`);
    expect(Object.keys(selected.body.data[0])).toEqual(["id"]);
    const excluded = await get(`${path}?exclude=createdAt&limit=1`);
    expect(excluded.body.data[0]).not.toHaveProperty("createdAt");
    expect((await get(`${path}?where[createdAt][gt]=2000-01-01`)).status).toBe(200);
  });

  test("GET list rejects invalid query parameters (400)", async () => {
    expect(detail(await get(`${path}?bogus=1`), "bogus")).toBe("Unknown parameter");
    expect(detail(await get(`${path}?limit=0`), "limit")).toBe("Must be an integer from 1 to 100");
    expect(detail(await get(`${path}?limit=101`), "limit")).toBe("Must be an integer from 1 to 100");
    expect(detail(await get(`${path}?offset=-1`), "offset")).toBe("Must be an integer of at least 0");
    expect(detail(await get(`${path}?sort=nope`), "sort")).toBe('Field "nope" cannot be sorted');
    expect(detail(await get(`${path}?where[nope][eq]=1`), "where[nope][eq]")).toBe('Field "nope" cannot be filtered');
    expect(detail(await get(`${path}?where[createdAt][like]=1`), "where[createdAt][like]")).toBe('Unknown operator "like"');
    expect(detail(await get(`${path}?where[createdAt][gt]=yesterday`), "where[createdAt][gt]")).toBe("Must be an ISO 8601 date");
    expect(detail(await get(`${path}?limit=1&limit=2`), "limit")).toBe("Parameter is repeated");
    expect(detail(await get(`${path}?fields=nope`), "fields")).toBe("Unknown field: nope");
    expect((await get(`${path}?populate=nope`)).body.error.message).toBe("Cannot populate: nope");
  });

  test("GET one (200) and missing (404)", async () => {
    const created = await create(path, await valid());
    const found = await get(`${path}/${created.id}`);
    expect([found.status, found.body.id]).toEqual([200, created.id]);
    expect(Object.keys((await get(`${path}/${created.id}?fields=id`)).body)).toEqual(["id"]);
    const missing = await get(`${path}/${MISSING}`);
    expect([missing.status, missing.body.error.code, missing.body.error.message]).toEqual([404, "NOT_FOUND", `${entity} not found`]);
  });

  test("PATCH updates (200), validates (400) and misses (404)", async () => {
    const created = await create(path, await valid());
    const patched = await patch(`${path}/${created.id}`, change);
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject(change);
    expect(new Date(patched.body.updatedAt).getTime()).toBeGreaterThan(new Date(created.updatedAt).getTime());
    expect(detail(await patch(`${path}/${created.id}`, { [wrongType[0]]: wrongType[1] }), wrongType[0])).toBe(wrongType[2]);
    expect(detail(await patch(`${path}/${created.id}`, { createdAt: "2020-01-01" }), "createdAt")).toBe("Field is read-only");
    expect((await patch(`${path}/${MISSING}`, change)).status).toBe(404);
  });

  test("PUT replaces (200), requires every field (400) and misses (404)", async () => {
    const created = await create(path, await valid());
    const body = await valid();
    const replaced = await put(`${path}/${created.id}`, body);
    expect([replaced.status, replaced.body.id]).toEqual([200, created.id]);
    const { [required]: _, ...missing } = body;
    expect(detail(await put(`${path}/${created.id}`, missing), required)).toBe("Is required");
    expect((await put(`${path}/${MISSING}`, body)).status).toBe(404);
  });

  test("DELETE removes (204), then misses (404)", async () => {
    const created = await create(path, await valid());
    const removed = await del(`${path}/${created.id}`);
    expect([removed.status, removed.body]).toEqual([204, {}]);
    expect((await get(`${path}/${created.id}`)).status).toBe(404);
    expect((await del(`${path}/${created.id}`)).status).toBe(404);
  });

  test("unsupported methods answer 405 with Allow", async () => {
    const result = await post(`${path}/${MISSING}`, {});
    expect([result.status, result.body.error.code]).toEqual([405, "METHOD_NOT_ALLOWED"]);
    expect(result.headers.get("allow")).toContain("GET");
    expect((await call("DELETE", path)).status).toBe(405);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Entity-specific rules.
// ---------------------------------------------------------------------------------------------------------------

describe("users", () => {
  test("role defaults to basic; reference arrays default to []", async () => {
    const user = await create("/users", { email: `${unique("u")}@x.co` });
    expect(user).toMatchObject({ role: "basic", name: null, picture: null, memberships: [], teams: [] });
    expect((await create("/users", { email: `${unique("u")}@x.co`, role: "admin" })).role).toBe("admin");
  });

  test("PUT replaces the whole record, so role is required there even with @default", async () => {
    const user = await create("/users", { email: `${unique("u")}@x.co` });
    const withoutRole = await put(`/users/${user.id}`, { email: `${unique("u")}@x.co` });
    expect([withoutRole.status, detail(withoutRole, "role")]).toEqual([400, "Is required"]);
    const replaced = await put(`/users/${user.id}`, { email: `${unique("u")}@x.co`, role: "admin" });
    expect([replaced.status, replaced.body.role, replaced.body.name]).toEqual([200, "admin", null]);
  });

  test("memberships and teams are filled from the other side", async () => {
    const { ana, membership, team } = await world();
    const found = await get(`/users/${ana.id}`);
    expect(found.body.memberships).toEqual([membership.id]);
    expect(found.body.teams).toEqual([team.id]);
    const populated = await get(`/users/${ana.id}?populate=memberships,teams`);
    expect(populated.body.memberships[0].id).toBe(membership.id);
    expect(populated.body.teams[0].name).toBe("Data");
    expect((await get(`/users?where[teams][contains]=${team.id}`)).body.data.map((user: Json) => user.id)).toEqual([ana.id]);
  });

  test("filters by enum and text, and rejects disallowed operators", async () => {
    const email = `${unique("filter")}@acme.co`;
    await create("/users", { email, role: "admin" });
    expect((await get(`/users?where[email][contains]=${email.toUpperCase()}`)).body.total).toBe(1);
    expect((await get(`/users?where[role][eq]=admin&where[email][startsWith]=${email.slice(0, 8)}`)).body.total).toBe(1);
    expect(detail(await get("/users?where[role][eq]=root"), "where[role][eq]")).toBe("Must be one of: admin, basic");
    expect(detail(await get("/users?where[role][gt]=a"), "where[role][gt]")).toBe('Operator "gt" is not allowed for this field');
  });

  test("a user with memberships cannot be deleted (409)", async () => {
    const { ana } = await world();
    const result = await del(`/users/${ana.id}`);
    expect([result.status, result.body.error.code, result.body.error.message]).toEqual([409, "CONFLICT", "Cannot delete: referenced by memberships"]);
  });

  test("a picture can be uploaded with the user (multipart)", async () => {
    const created = await post("/users", form([["email", `${unique("pic")}@x.co`], ["picture", png()]]));
    expect(created.status).toBe(201);
    const media = await get(`/media/${created.body.picture}`);
    expect(media.body).toMatchObject({ filename: "pic.png", mimeType: "image/png", size: 8 });
    const unknownPart = await post("/users", form([["email", `${unique("pic")}@x.co`], ["avatar", png()]]));
    expect([unknownPart.status, detail(unknownPart, "avatar")]).toEqual([400, "Unknown field"]);
  });
});

describe("organizations", () => {
  test("members are derived from memberships; modules keep their order", async () => {
    const { org, membership, billing, reports, legacy } = await world();
    const found = await get(`/organizations/${org.id}`);
    expect(found.body.members).toEqual([membership.id]);
    expect(found.body.modules).toEqual([billing.id, reports.id, legacy.id]);
    const populated = await get(`/organizations/${org.id}?populate=modules`);
    expect(populated.body.modules.map((module: Json) => module.id)).toEqual([billing.id, reports.id, legacy.id]);
  });

  test("reference arrays validate ids and support add/remove", async () => {
    const { org, billing, reports } = await world();
    const duplicate = await patch(`/organizations/${org.id}`, { modules: [billing.id, billing.id] });
    expect(detail(duplicate, "modules[1]")).toBe("Duplicate item");
    const missing = await patch(`/organizations/${org.id}`, { modules: [MISSING] });
    expect([missing.status, detail(missing, "modules[0]")]).toEqual([400, "Referenced record not found"]);
    const removed = await patch(`/organizations/${org.id}`, { modules: { remove: [billing.id] } });
    expect(removed.body.modules).not.toContain(billing.id);
    const added = await patch(`/organizations/${org.id}`, { modules: { add: [billing.id] } });
    expect(added.body.modules.at(-1)).toBe(billing.id);
    const conflicting = await patch(`/organizations/${org.id}`, { modules: { add: [reports.id], remove: [reports.id] } });
    expect(detail(conflicting, "modules")).toBe("Conflicting operations");
    expect(detail(await patch(`/organizations/${org.id}`, { modules: null }), "modules")).toBe("Cannot be null");
    expect((await get(`/organizations?where[modules][containsAll]=${billing.id},${reports.id}`)).body.total).toBeGreaterThan(0);
    expect((await get(`/organizations?where[modules][size][gte]=1&where[modules][isEmpty]=false`)).status).toBe(200);
  });

  test("an organization with memberships or teams cannot be deleted (409)", async () => {
    const { org } = await world();
    const result = await del(`/organizations/${org.id}`);
    expect(result.status).toBe(409);
    expect(result.body.error.message).toMatch(/^Cannot delete: referenced by (memberships|teams)$/);
  });

  test("an unused organization can be deleted", async () => {
    const lone = await create("/organizations", { slug: unique("lone"), legalName: "Lone", active: true });
    expect((await del(`/organizations/${lone.id}`)).status).toBe(204);
  });
});

describe("modules, permissions and profiles", () => {
  test("a module used by a permission cannot be deleted (409)", async () => {
    const { billing } = await world();
    const result = await del(`/modules/${billing.id}`);
    expect([result.status, result.body.error.message]).toEqual([409, "Cannot delete: referenced by permissions"]);
  });

  test("a permission must reference an existing module", async () => {
    const result = await post("/permissions", { module: MISSING, action: "view" });
    expect([result.status, detail(result, "module")]).toEqual([400, "Referenced record not found"]);
  });

  test("deleting a permission pulls it from profiles", async () => {
    const { finance, legacyManage } = await world();
    expect((await del(`/permissions/${legacyManage.id}`)).status).toBe(204);
    expect((await get(`/profiles/${finance.id}`)).body.permissions).not.toContain(legacyManage.id);
  });

  test("profiles populate permissions and their modules", async () => {
    const { finance } = await world();
    const result = await get(`/profiles/${finance.id}?populate=permissions.module`);
    expect(result.body.permissions[0].module.slug).toMatch(/^billing/);
  });

  test("populate deeper than populate.maxDepth fails (400)", async () => {
    const { membership } = await world();
    const result = await get(`/memberships/${membership.id}?populate=profiles.permissions.module.slug`);
    expect([result.status, result.body.error.message]).toEqual([400, "Populate depth exceeds 3"]);
  });
});

describe("teams and memberships", () => {
  test("team users are the storing side of the relation", async () => {
    const { team, ana } = await world();
    const bob = await create("/users", { email: `${unique("bob")}@x.co` });
    const updated = await patch(`/teams/${team.id}`, { users: { add: [bob.id] } });
    expect(updated.body.users).toEqual([ana.id, bob.id]);
    expect((await get(`/users/${bob.id}`)).body.teams).toEqual([team.id]);
    await patch(`/teams/${team.id}`, { users: [ana.id] });
    expect((await get(`/users/${bob.id}`)).body.teams).toEqual([]);
  });

  test("memberships require an existing user and organization", async () => {
    const { org } = await world();
    const result = await post("/memberships", { organization: org.id, user: MISSING, active: true });
    expect([result.status, detail(result, "user")]).toEqual([400, "Referenced record not found"]);
  });
});

describe("media and files", () => {
  test("uploads, reads, streams, renames, replaces and deletes a media file", async () => {
    const created = await post("/media", form([["file", png(16, "logo.png")]]));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ filename: "logo.png", mimeType: "image/png", size: 16, storage: "default", url: `/media/${created.body.id}/file` });
    expect(created.body).not.toHaveProperty("storageKey");
    const streamed = await fetchApp(new Request(`http://x${created.body.url}`));
    expect([streamed.status, streamed.headers.get("content-type"), streamed.headers.get("content-length")]).toEqual([200, "image/png", "16"]);
    expect(streamed.headers.get("content-disposition")).toBe('inline; filename="logo.png"');
    const renamed = await patch(`/media/${created.body.id}`, { filename: "brand.png" });
    expect(renamed.body.filename).toBe("brand.png");
    expect(detail(await patch(`/media/${created.body.id}`, { size: 1 }), "size")).toBe("Field is read-only");
    expect(detail(await patch(`/media/${created.body.id}`, { url: "x" }), "url")).toBe("Field is read-only");
    const replaced = await call("PUT", `/media/${created.body.id}`, form([["file", png(4, "new.png")]]));
    expect([replaced.status, replaced.body.size, replaced.body.filename]).toEqual([200, 4, "new.png"]);
    expect((await del(`/media/${created.body.id}`)).status).toBe(204);
    expect((await fetchApp(new Request(`http://x/media/${created.body.id}/file`))).status).toBe(404);
  });

  test("rejects JSON bodies (415), missing files (400), other types (400) and large files (413)", async () => {
    const json = await post("/media", { filename: "x.png" });
    expect([json.status, json.body.error.code, json.body.error.message]).toEqual([415, "UNSUPPORTED_MEDIA_TYPE", "Must be multipart/form-data"]);
    const noFile = await post("/media", form([["filename", "x"]]));
    expect([noFile.status, detail(noFile, "file")]).toEqual([400, "Is required"]);
    const pdf = await post("/media", form([["file", png(4, "doc.pdf", "application/pdf")]]));
    expect([pdf.status, detail(pdf, "file")]).toEqual([400, "File type not allowed"]);
    const large = await post("/media", form([["file", png(11 * 1024 * 1024, "big.png")]]));
    expect([large.status, large.body.error.code, large.body.error.message]).toEqual([413, "PAYLOAD_TOO_LARGE", "File too large"]);
  });

  test("media used as a picture cannot be deleted (409)", async () => {
    const created = await post("/users", form([["email", `${unique("pic")}@x.co`], ["picture", png()]]));
    const result = await del(`/media/${created.body.picture}`);
    expect(result.status).toBe(409);
    expect(result.body.error.message).toMatch(/^Cannot delete: referenced by (users|teams|organizations)$/);
  });

  test("generic files accept any type", async () => {
    const created = await post("/files", form([["file", png(4, "notes.pdf", "application/pdf")]]));
    expect([created.status, created.body.mimeType]).toEqual([201, "application/pdf"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The custom endpoint: GET /users/:userId/has-permissions.
// ---------------------------------------------------------------------------------------------------------------

describe("GET /users/:userId/has-permissions", () => {
  const check = (userId: string, query: string) => get(`/users/${userId}/has-permissions?${query}`);

  test("missing or invalid query items fail (400)", async () => {
    const { ana } = await world();
    const none = await check(ana.id, "");
    expect(none.status).toBe(400);
    expect(details(none).map((item) => [item.field, item.message])).toEqual([
      ["p", "Is required"],
      ["rule", "Is required"],
      ["organization", "Is required"],
    ]);
    const badRule = await check(ana.id, `organization=x&p=a:view&rule=some`);
    expect(detail(badRule, "rule")).toBe("Must be one of: all, any");
    const repeated = await check(ana.id, `organization=x&organization=y&p=a:view&rule=all`);
    expect(detail(repeated, "organization")).toBe("Parameter is repeated");
  });

  test("direct and team grants, with all and any", async () => {
    const { ana, org, billing, reports } = await world();
    const q = (rule: string, ...permissions: string[]) => `organization=${org.id}&rule=${rule}&${permissions.map((p) => `p=${p}`).join("&")}`;
    expect((await check(ana.id, q("all", `${billing.slug}:manage`))).body).toBe(true);
    expect((await check(ana.id, q("all", `${billing.slug}:view`))).body).toBe(true);
    expect((await check(ana.id, q("all", `${reports.slug}:view`))).body).toBe(true);
    expect((await check(ana.id, q("all", `${billing.slug}:manage`, `${reports.slug}:view`))).body).toBe(true);
    expect((await check(ana.id, q("all", `${reports.slug}:manage`))).body).toBe(false);
    expect((await check(ana.id, q("all", `${billing.slug}:manage`, `${reports.slug}:manage`))).body).toBe(false);
    expect((await check(ana.id, q("any", `${reports.slug}:manage`, `${reports.slug}:view`))).body).toBe(true);
    expect((await check(ana.id, q("any", "nothing:view", "other:manage"))).body).toBe(false);
  });

  test("inactive modules, memberships, teams and organizations grant nothing", async () => {
    const { ana, org, inactiveOrg, legacy, billing, reports, membership, team, finance } = await world();
    const q = (organization: string, permission: string) => `organization=${organization}&rule=all&p=${permission}`;
    expect((await check(ana.id, q(org.id, `${legacy.slug}:manage`))).body).toBe(false);
    await create("/memberships", { organization: inactiveOrg.id, user: ana.id, profiles: [finance.id], active: true });
    expect((await check(ana.id, q(inactiveOrg.id, `${billing.slug}:manage`))).body).toBe(false);
    expect((await check(ana.id, q(MISSING, `${billing.slug}:manage`))).body).toBe(false);
    await patch(`/memberships/${membership.id}`, { active: false });
    expect((await check(ana.id, q(org.id, `${billing.slug}:manage`))).body).toBe(false);
    expect((await check(ana.id, q(org.id, `${reports.slug}:view`))).body).toBe(true);
    await patch(`/teams/${team.id}`, { active: false });
    expect((await check(ana.id, q(org.id, `${reports.slug}:view`))).body).toBe(false);
  });

  test("users without grants, and unknown users, get false", async () => {
    const { org, billing } = await world();
    const loner = await create("/users", { email: `${unique("loner")}@x.co` });
    expect((await check(loner.id, `organization=${org.id}&rule=any&p=${billing.slug}:view`)).body).toBe(false);
    expect((await check(MISSING, `organization=${org.id}&rule=any&p=${billing.slug}:view`)).body).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Framework routes.
// ---------------------------------------------------------------------------------------------------------------

describe("framework routes", () => {
  test("unknown routes answer 404 Route not found", async () => {
    const result = await get("/nope");
    expect([result.status, result.body]).toEqual([404, { error: { code: "NOT_FOUND", message: "Route not found" } }]);
  });

  test("API docs are served", async () => {
    const document = await get("/openapi.json");
    expect([document.status, document.body.openapi]).toEqual([200, "3.1.0"]);
    expect(Object.keys(document.body.paths)).toContain("/users/{userId}/has-permissions");
    const page = await fetchApp(new Request("http://x/docs"));
    expect([page.status, page.headers.get("content-type")]).toEqual([200, "text/html; charset=utf-8"]);
  });
});
