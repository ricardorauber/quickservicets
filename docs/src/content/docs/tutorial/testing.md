---
title: Testing the API
description: Run the identity example's in-process API tests, see how they are built and add your own cases.
sidebar:
  order: 8
---

The identity example comes with an API test suite in `examples/identity/tests/api.test.ts`. It calls every route of the project, including the [permission check](/tutorial/permission-endpoint/) and the [API docs](/tutorial/api-docs/), and checks each outcome: success, validation errors, 404, 405, 409 and so on.

It runs **in-process**: no server, no port and, by default, no PostgreSQL. The tests build the project, start the generated app on an in-memory database and send it `Request` objects directly. Set `TEST_POSTGRES_URL` and every test runs a second time on PostgreSQL.

## Run it

From `examples/identity`:

```bash
bun test tests
```

```text
bun test v1.4.2 (744846f84)

 108 pass
 1 skip
 0 fail
 465 expect() calls
Ran 109 tests across 3 files. [2940.00ms]
```

Besides `tests/api.test.ts`, the folder has `tests/seed.test.ts`, which checks that the seed script (`scripts/seed.ts`, which `bun run seed` runs) can run twice without duplicating data, and `tests/migrations.test.ts`, the skipped one: it applies the project's migrations one after the other on PostgreSQL, so it runs only when `TEST_POSTGRES_URL` is set.

### On PostgreSQL

Point `TEST_POSTGRES_URL` at a database the tests may change. `tests/migrations.test.ts` replaces its `public` schema, so don't use the one you develop with:

```bash
TEST_POSTGRES_URL=postgres://postgres:postgres@localhost:5432/identity_test bun test tests
```

```text
bun test v1.4.2 (744846f84)

 216 pass
 0 fail
 930 expect() calls
Ran 216 tests across 3 files. [9250.00ms]
```

Every API test runs once on memory and once on PostgreSQL. For the PostgreSQL run, the suite creates a schema of its own with the project's migrations (`quickservice migrate` with `DATABASE_SCHEMA` set), runs the tests in it and drops it at the end, so runs never see each other's records.

`bun run test` does the same (it is the `test` script in `package.json`). To run some of the tests, filter by name with `-t`:

```bash
bun test tests -t "has-permissions"
```

```text
bun test v1.4.2 (744846f84)

 4 pass
 105 filtered out
 0 fail
 20 expect() calls
Ran 4 tests across 3 files. [1381.00ms]
```

## The test file

Here is the start of the file, its helpers and some of its cases. The `// …` lines mark the parts left out; everything else is exactly as in the example.

```ts check title="tests/api.test.ts"
/**
 * End-to-end tests of every route of this project, with every outcome each one can produce.
 * Runs the generated app in-process on an in-memory database: `bun test` in examples/identity. When TEST_POSTGRES_URL is
 * set, every test runs again on PostgreSQL, in a new schema created with the project's migrations and dropped afterwards.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, localStorage, memoryAdapter, postgresAdapter, resolveConfig, schemaIdentifier, type App, type DatabaseAdapter, type EntityModel } from "@quickservice/core";

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
  const migrated = Bun.spawnSync(["bun", "run", "quickservice", "migrate"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  if (migrated.exitCode !== 0) throw new Error(`migrate failed: ${migrated.stderr.toString()}${migrated.stdout.toString()}`);
  const database = postgresAdapter({ url });
  await database.connect(models, { defaultSchema: schema });
  return {
    database,
    async close() {
      await database.disconnect();
      const admin = new SQL(url);
      await admin.unsafe(`drop schema "${schemaIdentifier(schema)}" cascade`);
      await admin.close();
    },
  };
}

const databases: [string, (models: EntityModel[]) => Promise<TestDatabase>][] = [
  ["memory", memoryDatabase],
  ...(process.env.TEST_POSTGRES_URL ? [["PostgreSQL", postgresDatabase] as [string, typeof postgresDatabase]] : []),
];

let generated: { models: EntityModel[]; crudRoutes: any; endpoints: any; hooks: any; openApi: any; jobs: any };
let fetchApp: (request: Request) => Promise<Response>;
let app: App;

beforeAll(async () => {
  const built = Bun.spawnSync(["bun", "run", "quickservice", "build"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (built.exitCode !== 0) throw new Error(`build failed: ${built.stderr.toString()}${built.stdout.toString()}`);
  const { models } = await import(join(root, ".generated/models.ts"));
  const { crudRoutes, endpoints, hooks } = await import(join(root, ".generated/routes.ts"));
  const { jobs } = await import(join(root, ".generated/jobs.ts"));
  const openApi = await Bun.file(join(root, ".generated/openapi.json")).json();
  generated = { models, crudRoutes, endpoints, hooks, openApi, jobs };
});

/** Connects the database and starts the app on it; the tests send it requests through `fetchApp` and run jobs with `app`. */
async function startApp(open: (models: EntityModel[]) => Promise<TestDatabase>): Promise<TestDatabase> {
  const { models, crudRoutes, endpoints, hooks, openApi, jobs } = generated;
  const opened = await open(models);
  const config = resolveConfig(
    {
      database: opened.database,
      populate: { maxDepth: 3 },
      storage: { default: localStorage({ dir: mkdtempSync(join(tmpdir(), "identity-uploads-")) }) },
      logger: { info() {}, warn() {}, error() {} },
    },
    {},
  );
  app = createApp({ models, crudRoutes, endpoints, hooks, config, openApi, jobs });
  fetchApp = (request) => app.server.fetch(request);
  return opened;
}

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
// … png() and form() build files and multipart bodies …

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

describe.each(databases)("on %s", (_name, open) => {
  let opened: TestDatabase;
  beforeAll(async () => {
    opened = await startApp(open);
  }, 60_000);
  afterAll(() => opened?.close());

  // … the CRUD cases of every entity, then entity rules, data rules, media and files …

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

    // … direct and team grants, inactive records, users without grants …
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
});
```

The rest of this page goes through it, top to bottom.

## Building and starting the app

The top-level `beforeAll` runs once, before any test:

1. **Build.** It runs `quickservice build` in the project folder, which writes `.generated/`: the models, the routes (CRUD routes, custom endpoints and hooks), the types and `openapi.json`. When the build fails, the error is the build output, so a broken entity fails the suite right away.
2. **Import the generated code.** It imports `models` from `.generated/models.ts`, `crudRoutes`, `endpoints` and `hooks` from `.generated/routes.ts`, and reads `.generated/openapi.json`. These are the same pieces `.generated/server.ts` puts together for the real server.

Every test sits inside `describe.each(databases)`, which repeats them once per database: `memory`, and `PostgreSQL` when `TEST_POSTGRES_URL` is set. Its `beforeAll` calls `startApp`, and its `afterAll` cleans up:

3. **Connect the database.** `memoryDatabase` uses `memoryAdapter()`, which keeps everything in memory, so each run starts empty. `postgresDatabase` creates a new schema with the project's migrations and connects to it; its `close` drops the schema. The tests don't read `quickservice.config.ts`, so they never touch the database the project is configured with.
4. **Resolve the config.** `resolveConfig` fills every default, as it does for the real server. The test passes the database, the same `populate: { maxDepth: 3 }` as the project, a local storage in a temporary folder for uploads, and a logger that drops the request logs. The second argument, `{}`, is the environment: an empty one, so variables such as `NODE_ENV` don't change the config (the API docs stay on, for example).
5. **Create the app.** `createApp` returns a `server` whose `fetch(request)` handles a `Request` like the running service would: routing, hooks, validation, errors and all.

Nothing listens on a port: `fetchApp` is `server.fetch`.

## Helpers

- `call(method, path, body?, headers?)` sends one request and returns `{ status, body, headers }`. Objects are sent as JSON, strings as they are (handy for broken JSON) and `FormData` as multipart. The body is parsed as JSON when it can be.
- `get`, `post`, `patch`, `put` and `del` are shortcuts for each method.
- `create(path, body)` posts a record and returns it, and throws unless the answer is 201. Use it to set up data, not to test creation.
- `details(result)` returns the `details` of an error, and `detail(result, field)` the message for one field.
- `MISSING` is a well-formed id that no record has, for 404 cases.
- `unique(prefix)` returns a new value on each call, like `acme-12`. Every test in the file shares one database, so unique slugs and emails keep each test's records apart from the others.
- `world()` creates a complete graph: three modules (one inactive), an active and an inactive organization, permissions, the `finance` and `analyst` profiles, the user Ana, her membership with `finance` and her "Data" team with `analyst`. Each call creates a new graph, so a test can change its records freely.

## How the cases are organized

The file has six parts, each with a banner comment:

1. **Generated CRUD routes**, checked once per entity with `describe.each(crudCases)`. Each `CrudCase` gives a valid body, a required field, a field with a wrong type (and its message) and a valid change. Every entity gets the same cases: create (201), invalid bodies (400), list with paging, sorting, filters and field selection, invalid query parameters, read (200 and 404), PATCH, PUT, DELETE (204, then 404) and unsupported methods (405 with `Allow`).
2. **Entity rules**: defaults, derived relation sides, reference arrays, delete rules (409), uploads with a record, `populate` and its depth limit. Then the data rules of the field tags: duplicate emails and slugs (409), invalid emails, lengths outside their limits, pictures and logos of other types (400) or over 1 MB (413), and `active` defaulting to `true`.
3. **Media and files**: upload, stream, rename, replace, delete, and the 413 and 415 errors.
4. **The custom endpoint**: the query item errors shown above, then direct and team grants with `all` and `any`, inactive modules, memberships, teams and organizations, and users without grants.
5. **The stats endpoint, its `@requires` hook and the nightly job**: 401 without `x-user-id`, 403 without `organizations:view`, the counts and the 404, and the job run in-process with `app.jobRunner`. These parts of the example go beyond this tutorial; `examples/identity/README.md` explains them.
6. **Framework routes**: unknown routes (404) and the API docs.

## Adding a case

Add a `test` to the `describe` it belongs to, or a new `describe` for a new route:

1. Set up data with `world()`, or with `create(...)` and `unique(...)` for anything else.
2. Call the route with `get`, `post`, `patch`, `put`, `del` or `call`.
3. Check `status`, `body` and, for errors, `detail(result, field)`. Compare with the real messages from the [errors reference](/reference/errors/).

After you add an entity, also add a `CrudCase` to `crudCases`: it gets every generated-route case for free.

Since `beforeAll` builds the project, new entities and endpoints are picked up on the next run, with no separate build step.

:::tip
The messages in the suite are the API's contract. When a test compares a full message, like `"Must be one of: all, any"`, a client relying on it will break in the same place.
:::

## Reference

- [CLI](/reference/cli/): `quickservice build` and what it writes.
- [Configuration](/reference/config/): every key `resolveConfig` fills, such as `populate.maxDepth` and `storage`.
- [Errors](/reference/errors/): every status, code and message the tests check.
- [HTTP query parameters](/reference/http/): the paging, sorting and filter parameters of the list routes.

## Next

That's the whole identity example: a model, a custom endpoint, its docs and its tests. The [Guides](/guides/) explain each feature in depth.
