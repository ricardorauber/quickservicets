/**
 * End-to-end tests of every route of this project, with every outcome each one can produce.
 * Runs the generated app in-process on an in-memory database: `bun test` in examples/identity. When TEST_POSTGRES_URL is
 * set, every test runs again on PostgreSQL, in a new schema created with the project's migrations and dropped afterwards.
 */
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { SQL } from "bun";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createApp,
  createFeatureLifecycle,
  localStorage,
  memoryAdapter,
  postgresAdapter,
  resolveConfig,
  schemaIdentifier,
  type App,
  type DatabaseAdapter,
  type EntityModel,
  type FeatureLifecycle,
} from "@quickservicets/core";
import projectConfig from "../quickservicets.config.ts";

const root = join(import.meta.dir, "..");
type Json = Record<string, any>;
// The body is any JSON value: an object for most routes, a boolean for the permission check.
type Result = { status: number; body: any; headers: Headers };

/** A database for one run of the suite, and how to clean it up. */
type TestDatabase = { database: DatabaseAdapter; close(): Promise<void> };

async function memoryDatabase(models: EntityModel[]): Promise<TestDatabase> {
  const database = memoryAdapter();
  await database.connect(models);
  return { database, close: () => database.disconnect() };
}

async function postgresDatabase(models: EntityModel[]): Promise<TestDatabase> {
  const url = process.env.TEST_POSTGRES_URL!;
  const schema = `identity-test-${Date.now().toString(36)}`;
  const env = { ...process.env, DATABASE_URL: url, DATABASE_SCHEMA: schema };
  const migrated = Bun.spawnSync(["bun", "run", "quickservicets", "migrate"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  if (migrated.exitCode !== 0) throw new Error(`migrate failed: ${migrated.stderr.toString()}${migrated.stdout.toString()}`);
  const database = postgresAdapter({ url });
  await database.connect(models, { defaultSchema: schema });
  return {
    database,
    async close() {
      await database.disconnect();
      const admin = new SQL(url);
      // quickservicets-allow-unsafe: drops this test's schema, quoted by schemaIdentifier
      await admin.unsafe(`drop schema "${schemaIdentifier(schema)}" cascade`);
      await admin.close();
    },
  };
}

const databases: [string, (models: EntityModel[]) => Promise<TestDatabase>][] = [
  ["memory", memoryDatabase],
  ...(process.env.TEST_POSTGRES_URL ? [["PostgreSQL", postgresDatabase] as [string, typeof postgresDatabase]] : []),
];

let generated: { models: EntityModel[]; crudRoutes: any; endpoints: any; hooks: any; openApi: any; jobs: any; featureFolders: any };
let fetchApp: (request: Request, peer?: string) => Promise<Response>;
let app: App;
let lifecycle: FeatureLifecycle;

beforeAll(async () => {
  const built = Bun.spawnSync(["bun", "run", "quickservicets", "build"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (built.exitCode !== 0) throw new Error(`build failed: ${built.stderr.toString()}${built.stdout.toString()}`);
  const { models } = await import(join(root, ".generated/models.ts"));
  const { crudRoutes, endpoints, hooks } = await import(join(root, ".generated/routes.ts"));
  const { jobs } = await import(join(root, ".generated/jobs.ts"));
  const { featureFolders } = await import(join(root, ".generated/features.ts"));
  const openApi = await Bun.file(join(root, ".generated/openapi.json")).json();
  generated = { models, crudRoutes, endpoints, hooks, openApi, jobs, featureFolders };
});

let peers = 0;

/**
 * Connects the database and starts the project's app on it, with its config and native features, as the server does;
 * the tests send it requests through `fetchApp` and run jobs with `app`.
 */
async function startApp(open: (models: EntityModel[]) => Promise<TestDatabase>): Promise<TestDatabase> {
  const { models, crudRoutes, endpoints, hooks, openApi, jobs, featureFolders } = generated;
  const opened = await open(models);
  const config = resolveConfig(
    {
      ...projectConfig,
      database: opened.database,
      storage: { default: localStorage({ dir: mkdtempSync(join(tmpdir(), "identity-uploads-")) }) },
      logger: { info() {}, warn() {}, error() {} },
    },
    {},
  );
  lifecycle = createFeatureLifecycle({ features: config.features, config, models, featureFolders, endpoints, crudRoutes, worker: { index: 0, count: 1, runsScheduledWork: false } });
  await lifecycle.setup();
  app = createApp({ models, crudRoutes, endpoints, hooks, config, openApi, jobs, featureFolders, runtimeRoutes: lifecycle.routes, middleware: lifecycle.middleware, server: lifecycle.server });
  await lifecycle.start({ repos: app.repos as never, server: app.server });
  // Each request comes from its own address, so the rate limits only count the requests a test sends from one.
  fetchApp = (request, peer = `10.9.${Math.floor(++peers / 250) % 250}.${peers % 250}`) => app.server.fetch(request, { peer });
  return {
    database: opened.database,
    async close() {
      await lifecycle.shutdown();
      await lifecycle.stop();
      await opened.close();
    },
  };
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, peer?: string): Promise<Result> {
  const init: RequestInit = { method, headers };
  if (body instanceof FormData) init.body = body;
  else if (typeof body === "string") init.body = body;
  else if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetchApp(new Request(`http://x${path}`, init), peer);
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
    valid: async () => ({ slug: unique("o"), legalName: "Org", active: true, plan: "free" }),
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
    required: "user",
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

describe.each(databases)("on %s", (_name, open) => {
  let opened: TestDatabase;
  beforeAll(async () => {
    opened = await startApp(open);
  }, 60_000);
  afterAll(() => opened?.close());

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

  describe("data rules", () => {
    const conflict = (result: Result, field: string) => [result.status, result.body.error.message, detail(result, field)];
    const long = (length: number) => "x".repeat(length);

    test("emails are unique, valid and at most 254 characters", async () => {
      const email = `${unique("twin")}@x.co`;
      await create("/users", { email });
      expect(conflict(await post("/users", { email }), "email")).toEqual([409, "Value already exists", "Value already exists"]);
      const invalid = await post("/users", { email: "abc" });
      expect([invalid.status, detail(invalid, "email")]).toEqual([400, "Must be a valid email"]);
      expect(detail(await post("/users", { email: `${long(250)}@x.co` }), "email")).toBe("Must be at most 254 characters");
      expect((await post("/users", { email: `${long(249)}@x.co` })).status).toBe(201);
    });

    test("user names have 1 to 120 characters", async () => {
      expect(detail(await post("/users", { email: `${unique("u")}@x.co`, name: "" }), "name")).toBe("Must be at least 1 characters");
      expect(detail(await post("/users", { email: `${unique("u")}@x.co`, name: long(121) }), "name")).toBe("Must be at most 120 characters");
      expect((await post("/users", { email: `${unique("u")}@x.co`, name: long(120) })).status).toBe(201);
    });

    test.each([
      ["/modules", (slug: string) => ({ slug })],
      ["/organizations", (slug: string) => ({ slug, legalName: "Org" })],
      ["/profiles", (slug: string) => ({ slug })],
    ])("%s slugs are unique and have 2 to 64 characters", async (path, body) => {
      const slug = unique("slug");
      await create(path, body(slug));
      expect(conflict(await post(path, body(slug)), "slug")).toEqual([409, "Value already exists", "Value already exists"]);
      const short = await post(path, body("a"));
      expect([short.status, detail(short, "slug")]).toEqual([400, "Must be at least 2 characters"]);
      expect(detail(await post(path, body(long(65))), "slug")).toBe("Must be at most 64 characters");
      expect((await post(path, body(`${slug}-${long(40)}`))).status).toBe(201);
      expect((await post(path, body(unique("s").slice(0, 2)))).status).toBe(201);
    });

    test("organization legal names have 1 to 200 characters, names 1 to 120", async () => {
      const organization = (fields: Json) => post("/organizations", { slug: unique("o"), legalName: "Org", ...fields });
      expect(detail(await organization({ legalName: "" }), "legalName")).toBe("Must be at least 1 characters");
      expect(detail(await organization({ legalName: long(201) }), "legalName")).toBe("Must be at most 200 characters");
      expect((await organization({ legalName: long(200) })).status).toBe(201);
      expect(detail(await organization({ name: "" }), "name")).toBe("Must be at least 1 characters");
      expect(detail(await organization({ name: long(121) }), "name")).toBe("Must be at most 120 characters");
      expect((await organization({ name: long(120) })).status).toBe(201);
    });

    test("team names have 1 to 120 characters", async () => {
      const { org } = await world();
      const team = (name: string) => post("/teams", { organization: org.id, name });
      expect(detail(await team(""), "name")).toBe("Must be at least 1 characters");
      expect(detail(await team(long(121)), "name")).toBe("Must be at most 120 characters");
      expect((await team(long(120))).status).toBe(201);
    });

    test.each([
      ["/users", "picture", () => [["email", `${unique("pic")}@x.co`]]],
      ["/organizations", "logo", () => [["slug", unique("logo")], ["legalName", "Org"]]],
      ["/teams", "picture", async () => [["organization", (await create("/organizations", { slug: unique("o"), legalName: "Org" })).id], ["name", "Team"]]],
    ] as [string, string, () => Promise<[string, string][]> | [string, string][]][])(
      "%s %s accepts PNG, JPEG and WebP images up to 1 MB",
      async (path, field, fields) => {
        for (const [name, type] of [["pic.png", "image/png"], ["pic.jpg", "image/jpeg"], ["pic.webp", "image/webp"]] as const) {
          const accepted = await post(path, form([...(await fields()), [field, png(8, name, type)]]));
          expect([accepted.status, (await get(`/media/${accepted.body[field]}`)).body.mimeType]).toEqual([201, type]);
        }
        const gif = await post(path, form([...(await fields()), [field, png(8, "pic.gif", "image/gif")]]));
        expect([gif.status, detail(gif, field)]).toEqual([400, "File type not allowed"]);
        const large = await post(path, form([...(await fields()), [field, png(2 * 1024 * 1024)]]));
        expect([large.status, large.body.error.message, detail(large, field)]).toEqual([413, "File too large", "File too large"]);
        expect((await post(path, form([...(await fields()), [field, png(1024 * 1024)]]))).status).toBe(201);
      },
    );

    test("active defaults to true", async () => {
      const module = await create("/modules", { slug: unique("m") });
      const org = await create("/organizations", { slug: unique("o"), legalName: "Org" });
      const user = await create("/users", { email: `${unique("u")}@x.co` });
      const membership = await create("/memberships", { organization: org.id, user: user.id });
      const team = await create("/teams", { organization: org.id, name: "Team" });
      expect([module.active, org.active, membership.active, team.active]).toEqual([true, true, true, true]);
      expect((await get(`/modules/${module.id}`)).body.active).toBe(true);
      expect((await create("/modules", { slug: unique("m"), active: false })).active).toBe(false);
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

    test("File is not built, since no entity references it and no storage is set", async () => {
      const created = await post("/files", form([["file", png(4, "notes.pdf", "application/pdf")]]));
      expect(created.status).toBe(404);
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

    test("@rateLimit 30/min: the 31st check from one address within a minute answers 429 with Retry-After", async () => {
      const { ana, org } = await world();
      setSystemTime(new Date("2026-11-02T10:00:00Z"));
      try {
        const query = `p=billing:manage&rule=all&organization=${org.id}`;
        for (let index = 0; index < 30; index++) expect((await call("GET", `/users/${ana.id}/has-permissions?${query}`, undefined, {}, "203.0.113.7")).status).toBe(200);
        const limited = await call("GET", `/users/${ana.id}/has-permissions?${query}`, undefined, {}, "203.0.113.7");
        expect([limited.status, limited.body.error.code]).toEqual([429, "RATE_LIMITED"]);
        expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
        expect((await call("GET", `/users/${ana.id}/has-permissions?${query}`, undefined, {}, "203.0.113.8")).status).toBe(200);
      } finally {
        setSystemTime();
      }
    });

    test("users without grants, and unknown users, get false", async () => {
      const { org, billing } = await world();
      const loner = await create("/users", { email: `${unique("loner")}@x.co` });
      expect((await check(loner.id, `organization=${org.id}&rule=any&p=${billing.slug}:view`)).body).toBe(false);
      expect((await check(MISSING, `organization=${org.id}&rule=any&p=${billing.slug}:view`)).body).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // The stats endpoint, its @requires hook and the nightly job.
  // ---------------------------------------------------------------------------------------------------------------

  describe("GET /organizations/:orgId/stats", () => {
    const stats = (orgId: string, userId?: string) => call("GET", `/organizations/${orgId}/stats`, undefined, userId ? { "x-user-id": userId } : {});
    let viewer: Json;
    let other: Json;

    beforeAll(async () => {
      // The permission the endpoint requires names the module by slug, and slugs are unique: create it once.
      const organizations = await create("/modules", { slug: "organizations" });
      viewer = await create("/profiles", { slug: unique("viewer"), permissions: [(await create("/permissions", { module: organizations.id, action: "view" })).id] });
      const billing = await create("/modules", { slug: unique("billing") });
      other = await create("/profiles", { slug: unique("other"), permissions: [(await create("/permissions", { module: billing.id, action: "manage" })).id] });
    });

    /** An organization with three memberships (one inactive), two teams (one inactive) and two distinct profiles. */
    async function organization() {
      const org = await create("/organizations", { slug: unique("stats"), legalName: "Stats Ltd" });
      const [ana, bob, cid, dee] = await Promise.all(["ana", "bob", "cid", "dee"].map((name) => create("/users", { email: `${unique(name)}@x.co` })));
      await create("/memberships", { organization: org.id, user: ana!.id, profiles: [viewer.id] });
      await create("/memberships", { organization: org.id, user: bob!.id, profiles: [other.id] });
      await create("/memberships", { organization: org.id, user: cid!.id, profiles: [viewer.id], active: false });
      await create("/teams", { organization: org.id, name: "Data", users: [dee!.id], profiles: [viewer.id] });
      await create("/teams", { organization: org.id, name: "Old", users: [bob!.id], profiles: [viewer.id], active: false });
      return { org, ana: ana!, bob: bob!, cid: cid!, dee: dee! };
    }

    test("@requires answers 401 without x-user-id and 403 without the permission", async () => {
      const { org, bob, cid } = await organization();
      const anonymous = await stats(org.id);
      expect([anonymous.status, anonymous.body.error.code, anonymous.body.error.message]).toEqual([401, "UNAUTHORIZED", "Missing x-user-id header"]);
      for (const userId of [bob.id, cid.id, MISSING]) {
        const denied = await stats(org.id, userId);
        expect([denied.status, denied.body.error.code, denied.body.error.message]).toEqual([403, "FORBIDDEN", "Missing permission organizations:view"]);
      }
    });

    test("@requires lets members and team members with the permission through", async () => {
      const { org, ana, dee } = await organization();
      expect((await stats(org.id, ana.id)).status).toBe(200);
      expect((await stats(org.id, dee.id)).status).toBe(200);
      await patch(`/organizations/${org.id}`, { active: false });
      expect((await stats(org.id, ana.id)).body.error.message).toBe("Missing permission organizations:view");
    });

    test("counts the memberships, teams and distinct profiles of the organization", async () => {
      const { org, ana } = await organization();
      await organization();
      const result = await stats(org.id, ana.id);
      expect([result.status, result.body]).toEqual([200, { members: 3, activeMembers: 2, teams: 2, activeTeams: 1, profiles: 2 }]);
      const empty = await create("/organizations", { slug: unique("empty"), legalName: "Empty" });
      const loner = await create("/users", { email: `${unique("loner")}@x.co` });
      await create("/teams", { organization: empty.id, name: "Admins", users: [loner.id], profiles: [viewer.id] });
      expect((await stats(empty.id, loner.id)).body).toEqual({ members: 0, activeMembers: 0, teams: 1, activeTeams: 1, profiles: 1 });
    });

    test("organizations on the pro plan get the number of their active modules, through the detailed-stats flag", async () => {
      const { org, ana } = await organization();
      const [billing, reports, legacy] = await Promise.all([
        create("/modules", { slug: unique("billing") }),
        create("/modules", { slug: unique("reports") }),
        create("/modules", { slug: unique("legacy"), active: false }),
      ]);
      await patch(`/organizations/${org.id}`, { modules: [billing.id, reports.id, legacy.id] });
      expect((await stats(org.id, ana.id)).body).not.toHaveProperty("modules");
      expect((await patch(`/organizations/${org.id}`, { plan: "pro" })).status).toBe(200);
      expect((await stats(org.id, ana.id)).body).toEqual({ members: 3, activeMembers: 2, teams: 2, activeTeams: 1, profiles: 2, modules: 2 });
      await patch(`/organizations/${org.id}`, { plan: "free" });
      expect((await stats(org.id, ana.id)).body).not.toHaveProperty("modules");
    });

    test("@rateLimit 30/min: the 31st request from one address within a minute answers 429", async () => {
      const { org, ana } = await organization();
      setSystemTime(new Date("2026-11-02T11:00:00Z"));
      try {
        for (let index = 0; index < 30; index++) expect((await call("GET", `/organizations/${org.id}/stats`, undefined, { "x-user-id": ana.id }, "203.0.113.9")).status).toBe(200);
        const limited = await call("GET", `/organizations/${org.id}/stats`, undefined, { "x-user-id": ana.id }, "203.0.113.9");
        expect([limited.status, Number(limited.headers.get("retry-after")) > 0]).toEqual([429, true]);
      } finally {
        setSystemTime();
      }
    });

    test("an unknown organization answers 404", async () => {
      const { ana } = await organization();
      const result = await stats(MISSING, ana.id);
      expect([result.status, result.body.error.code, result.body.error.message]).toEqual([404, "NOT_FOUND", "Organization not found"]);
      expect((await stats(MISSING)).status).toBe(401);
    });
  });

  describe("job deactivate-memberships-of-inactive-organizations", () => {
    const name = "deactivate-memberships-of-inactive-organizations";
    let at = Date.now();
    const runJob = async () => (await app.jobRunner.run({ job: name, trigger: "manual", scheduledAt: new Date(at++), attempt: 1 }))!;

    test("deactivates the active memberships of inactive organizations and returns how many", async () => {
      await runJob(); // Other tests leave active memberships in inactive organizations; start from none.
      const inactive = await create("/organizations", { slug: unique("closed"), legalName: "Closed", active: false });
      const active = await create("/organizations", { slug: unique("open"), legalName: "Open" });
      const [ana, bob] = await Promise.all(["ana", "bob"].map((user) => create("/users", { email: `${unique(user)}@x.co` })));
      const closed = await Promise.all([ana, bob].map((user) => create("/memberships", { organization: inactive.id, user: user!.id })));
      const kept = await create("/memberships", { organization: active.id, user: ana!.id });

      const run = await runJob();
      expect([run.status, run.result]).toEqual(["success", 2]);
      for (const membership of closed) expect((await get(`/memberships/${membership.id}`)).body.active).toBe(false);
      expect((await get(`/memberships/${kept.id}`)).body.active).toBe(true);
      expect((await runJob()).result).toBe(0);
    });

    test("is scheduled daily at 03:00 UTC", () => {
      const listed = Bun.spawnSync(["bun", "run", "quickservicets", "job", "list"], { cwd: root, stdout: "pipe", stderr: "pipe" }).stdout.toString();
      expect(listed).toMatch(new RegExp(`${name}\\s+0 3 \\* \\* \\*\\s+UTC`));
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Framework routes.
  // ---------------------------------------------------------------------------------------------------------------

  // ---------------------------------------------------------------------------------------------------------------
  // The native features: history, idempotency and health.
  // ---------------------------------------------------------------------------------------------------------------

  describe("history of permission changes", () => {
    test("a membership's profile change is version 2, with the changed field, and version 1 stays readable", async () => {
      const { membership, finance, analyst } = await world();
      expect((await patch(`/memberships/${membership.id}`, { profiles: [finance.id, analyst.id] })).status).toBe(200);
      const versions = await get(`/memberships/${membership.id}/history`);
      expect(versions.status).toBe(200);
      expect(versions.body.total).toBe(2);
      const latest = versions.body.data[0];
      expect([latest.version, latest.operation, latest.changed]).toEqual([2, "update", ["profiles"]]);
      expect(latest.record.profiles).toEqual([finance.id, analyst.id]);
      const first = await get(`/memberships/${membership.id}/history/1`);
      expect([first.status, first.body.operation, first.body.record.profiles]).toEqual([200, "create", [finance.id]]);
    });

    test("profiles and teams keep their versions too", async () => {
      const { finance, team, billingManage } = await world();
      await patch(`/profiles/${finance.id}`, { permissions: [billingManage.id] });
      await patch(`/teams/${team.id}`, { active: false });
      expect((await get(`/profiles/${finance.id}/history`)).body.data.map((version: Json) => version.operation)).toEqual(["update", "create"]);
      expect((await get(`/teams/${team.id}/history`)).body.data[0].changed).toEqual(["active"]);
      expect((await get(`/modules/${MISSING}/history`)).status).toBe(404);
    });
  });

  describe("idempotent organization creation", () => {
    test("the same Idempotency-Key and body replay the first 201, and another body answers 422", async () => {
      const key = unique("key");
      const body = { slug: unique("idem"), legalName: "Idem Ltd" };
      const first = await post("/organizations", body, { "idempotency-key": key });
      const second = await post("/organizations", body, { "idempotency-key": key });
      expect([first.status, second.status]).toEqual([201, 201]);
      expect(second.body).toEqual(first.body);
      expect([first.headers.get("idempotent-replayed"), second.headers.get("idempotent-replayed")]).toEqual([null, "true"]);
      expect((await get(`/organizations?where[slug][eq]=${body.slug}`)).body.total).toBe(1);
      const other = await post("/organizations", { ...body, legalName: "Other" }, { "idempotency-key": key });
      expect(other.status).toBe(422);
    });
  });

  describe("health routes", () => {
    test("GET /health/ready checks the database, /health/live answers, and GET /health is gone", async () => {
      const ready = await get("/health/ready");
      expect([ready.status, ready.body.status, ready.body.checks.database.status]).toEqual([200, "ok", "ok"]);
      expect((await get("/health/live")).status).toBe(200);
      expect((await get("/health")).status).toBe(404);
    });
  });

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
});
