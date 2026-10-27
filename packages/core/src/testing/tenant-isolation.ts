import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseAdapter } from "../adapter.ts";
import { memoryAdapter } from "../adapters/memory.ts";
import { mongodbAdapter, type MongodbAdapter } from "../adapters/mongodb.ts";
import { postgresAdapter, type PostgresAdapter } from "../adapters/postgres.ts";
import { sqliteAdapter, type SqliteAdapter } from "../adapters/sqlite.ts";
import { createApp, type App, type AppEndpoint, type CrudRouteEntry } from "../app.ts";
import { resolveConfig, type ServiceConfig } from "../config.ts";
import { currentDatabaseScope } from "../database-scope.ts";
import { entityModel, field } from "../entity-model.ts";
import { defineFeature, registerNative, unregisterNative } from "../features.ts";
import { events } from "../features/events/bus.ts";
import { outboxDeliveryEntity } from "../features/events/delivery.ts";
import { outboxEventEntity } from "../features/events/outbox.ts";
import { idempotencyKeyEntity } from "../features/idempotency/store.ts";
import { queue, queueMessageEntity } from "../features/queues/index.ts";
import { markTenancy } from "../features/tenancy/models.ts";
import { MONGO_MIGRATIONS_COLLECTION } from "../features/tenancy/migrate.ts";
import { stagingModels } from "../features/tenancy/relay.ts";
import { builtInFileEntity } from "../files.ts";
import type { ServiceRequest } from "../hooks.ts";
import type { Endpoint } from "../http/server.ts";
import { job } from "../jobs/job.ts";
import { jobRunEntity } from "../jobs/job-run.ts";
import { createFeatureLifecycle, type FeatureLifecycle } from "../lifecycle.ts";
import { CRUD_OPERATIONS, entityRoutePath, type EntityModel, type FieldModel } from "../model.ts";
import type { Repository, RepositoryRegistry } from "../repository.ts";
import { localStorage } from "../storage/local.ts";
import { runForTenant } from "../tenant-runs.ts";
import { fileSamples } from "./file-samples.ts";
import { postgresDdl } from "./postgres.ts";
import { createSqliteTables } from "./sql.ts";

/** The databases the suite runs on. */
export type IsolationAdapter = "memory" | "sqlite" | "postgres" | "mongodb";

/** What `runTenantIsolationSuite` takes. */
export interface TenantIsolationOptions {
  /** A name for the run, shown in the test names after the adapter and the strategy. */
  name?: string;
  adapter: IsolationAdapter;
  strategy: "schema" | "database";
  /** The URL of the PostgreSQL or MongoDB server; without it those adapters register one named skipped test. */
  url?: string;
  /** The names of the project's entities (from `models`) that also get the read and write checks. */
  entities?: string[];
  /** The project's models holding `entities`, like the `models` of `.generated/models.ts`. */
  models?: EntityModel[];
  /** The prefix of the schemas and databases the suite creates and drops (default `isolation`). */
  prefix?: string;
  /** For the suite's own test: a resolver that keeps the first tenant's repositories for every request. */
  brokenResolver?: boolean;
}

const TENANTS = ["alpha", "beta"] as const;
type Tenant = (typeof TENANTS)[number];
const OTHER: Record<Tenant, Tenant> = { alpha: "beta", beta: "alpha" };
const SKIP_HINT: Record<string, string> = { postgres: "set TEST_POSTGRES_URL to run", mongodb: "set TEST_MONGODB_URL to run" };

/** The fixture: notes with a unique slug, tags, a reference array, a file, comments that cascade, and a shared plan. */
function fixtureModels(extra: readonly EntityModel[]): EntityModel[] {
  const tag = entityModel("Tag", { name: field({ type: "string" }) });
  const note = {
    ...entityModel("Note", {
      slug: field({ type: "string", unique: true }),
      title: field({ type: "string" }),
      tag: field({ type: "ref", target: "Tag", optional: true, onDelete: "setNull" }),
      tags: field({ type: "refArray", target: "Tag", optional: true }),
      cover: field({ type: "ref", target: "Media", optional: true, onDelete: "setNull" }),
    }),
    tags: { changes: { on: true, options: {} } },
  };
  const comment = entityModel("Comment", { text: field({ type: "string" }), note: field({ type: "ref", target: "Note", onDelete: "cascade" }) });
  const plan = { ...entityModel("Plan", { name: field({ type: "string" }) }), tags: { tenancy: { on: true, options: { scope: "shared" } } } };
  const core = [queueMessageEntity(), outboxEventEntity(), outboxDeliveryEntity(), jobRunEntity(), idempotencyKeyEntity()];
  return markTenancy([tag, note, comment, plan, builtInFileEntity("media"), ...extra.filter((model) => !["Tag", "Note", "Comment", "Plan", "Media"].includes(model.key)), ...core]);
}

/** A valid create body of a model, with values that differ per tenant for unique fields. */
function sampleBody(model: EntityModel, tenant: string): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const value = (item: FieldModel): unknown => {
    if (item.type === "enum") return item.values[0];
    if (item.type === "number") return item.min ?? 1;
    if (item.type === "boolean") return true;
    if (item.type === "date") return new Date().toISOString();
    if (item.type === "string") return item.format === "email" ? `${tenant}@example.com` : `${tenant}-${item.name}`.padEnd(Math.max(item.minLength ?? 0, 1), "x");
    return undefined;
  };
  for (const item of model.fields) {
    if (item.optional || item.default !== undefined || item.readOnly || item.storage !== "column") continue;
    const sample = value(item);
    if (sample !== undefined) body[item.name] = sample;
  }
  return body;
}

interface Running {
  app: App;
  lifecycle: FeatureLifecycle;
  root: DatabaseAdapter;
  fetch(path: string, init?: RequestInit & { tenant?: Tenant; host?: string }): Promise<Response>;
  seeded: Record<Tenant, { tag: string; note: string; comment: string; media: string; slug: string }>;
  cleanup: (() => Promise<void> | void)[];
  /** What background code saw, by marker. */
  seen: Record<string, unknown[]>;
  upstream: ReturnType<typeof Bun.serve>;
}

let suites = 0;

/**
 * Registers the tenant isolation suite as `bun:test` tests: it starts an app with its fixture (and the project's
 * `entities`) on a fresh database, provisions tenants `alpha` and `beta` with the strategy, seeds each, and checks
 * through `server.fetch` that reads, writes, tenant resolution, background work and caches never cross tenants, each
 * check its own named test, like `isolation: read beta's note as alpha`.
 */
export function runTenantIsolationSuite(options: TenantIsolationOptions): void {
  const label = `tenant isolation: ${options.adapter} ${options.strategy}${options.name ? ` ${options.name}` : ""}`;
  if ((options.adapter === "postgres" || options.adapter === "mongodb") && !options.url) {
    test.skip(`tenant isolation: ${options.adapter} (${SKIP_HINT[options.adapter]})`, () => {});
    return;
  }
  const projectModels = (options.entities ?? []).map((name) => {
    const model = options.models?.find((candidate) => candidate.key === name || candidate.entityName === name);
    if (!model) throw new Error(`runTenantIsolationSuite: entity ${name} is not in models`);
    return model;
  });
  const prefix = (options.prefix ?? "isolation").replaceAll("_", "-");
  const suite = ++suites;
  describe(label, () => {
    let state: Running;
    beforeAll(async () => {
      state = await startSuite(options, projectModels, prefix, suite);
    }, 60_000);
    afterAll(async () => {
      for (const cleanup of state?.cleanup.reverse() ?? []) await cleanup();
    }, 60_000);

    const json = async (response: Response) => (await response.json()) as Record<string, unknown>;
    const slugsAs = async (tenant: Tenant, query = "") => ((await json(await state.fetch(`/notes${query}`, { tenant }))).data as { slug: string }[]).map((note) => note.slug).sort();

    describe("reads", () => {
      for (const tenant of TENANTS) {
        const other = OTHER[tenant];
        test(`isolation: list ${other}'s notes as ${tenant}`, async () => {
          expect(await slugsAs(tenant)).toEqual([`${tenant}-note`]);
        });
        test(`isolation: read ${other}'s note as ${tenant}`, async () => {
          expect((await state.fetch(`/notes/${state.seeded[other].note}`, { tenant })).status).toBe(404);
          expect((await state.fetch(`/notes/${state.seeded[tenant].note}`, { tenant })).status).toBe(200);
        });
      }
      test("isolation: filter by beta's ids and values as alpha", async () => {
        expect(await slugsAs("alpha", `?where[id][in]=${state.seeded.beta.note}`)).toEqual([]);
        expect(await slugsAs("alpha", "?where[slug][eq]=beta-note")).toEqual([]);
        expect(await slugsAs("alpha", `?where[id][in]=${state.seeded.beta.note},${state.seeded.alpha.note}`)).toEqual(["alpha-note"]);
      });
      test("isolation: populate references as alpha", async () => {
        const note = await json(await state.fetch(`/notes/${state.seeded.alpha.note}?populate=tag,tags`, { tenant: "alpha" }));
        expect([(note.tag as { name: string }).name, (note.tags as { name: string }[]).map((tag) => tag.name)]).toEqual(["alpha-tag", ["alpha-tag"]]);
      });
      test("isolation: aggregate as alpha", async () => {
        expect(await json(await state.fetch("/isolation/count", { tenant: "alpha" }))).toEqual({ notes: 1, tags: expect.any(Number) });
      });
      test("isolation: related records of beta's note as alpha", async () => {
        expect(await json(await state.fetch(`/isolation/related/${state.seeded.beta.note}`, { tenant: "alpha" }))).toEqual({ tags: [] });
        expect(await json(await state.fetch(`/isolation/related/${state.seeded.alpha.note}`, { tenant: "alpha" }))).toEqual({ tags: ["alpha-tag"] });
      });
      test("isolation: download beta's file as alpha", async () => {
        expect((await state.fetch(`/media/${state.seeded.beta.media}/file`, { tenant: "alpha" })).status).toBe(404);
        expect((await state.fetch(`/media/${state.seeded.alpha.media}/file`, { tenant: "alpha" })).status).toBe(200);
      });
    });

    describe("writes", () => {
      test("isolation: change and delete beta's note as alpha", async () => {
        const before = await (await state.fetch(`/notes/${state.seeded.beta.note}`, { tenant: "beta" })).text();
        const id = state.seeded.beta.note;
        const body = (value: unknown) => ({ method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(value), tenant: "alpha" as const });
        expect((await state.fetch(`/notes/${id}`, body({ title: "taken" }))).status).toBe(404);
        expect((await state.fetch(`/notes/${id}`, { ...body({ slug: "x", title: "taken" }), method: "PUT" })).status).toBe(404);
        expect((await state.fetch(`/notes/${id}`, { method: "DELETE", tenant: "alpha" })).status).toBe(404);
        expect(await (await state.fetch(`/notes/${id}`, { tenant: "beta" })).text()).toBe(before);
      });
      test("isolation: reference beta's tag as alpha", async () => {
        const response = await post(state, "alpha", "/notes", { slug: "stolen", title: "x", tag: state.seeded.beta.tag });
        expect(response.status).toBe(400);
        const refs = await post(state, "alpha", "/notes", { slug: "stolen-2", title: "x", tags: [state.seeded.beta.tag] });
        expect(refs.status).toBe(400);
      });
      test("isolation: cascades stay in alpha", async () => {
        const note = (await json(await post(state, "alpha", "/notes", { slug: "doomed", title: "x" }))).id as string;
        const comment = (await json(await post(state, "alpha", "/comments", { text: "bye", note }))).id as string;
        expect((await state.fetch(`/notes/${note}`, { method: "DELETE", tenant: "alpha" })).status).toBe(204);
        expect((await state.fetch(`/comments/${comment}`, { tenant: "alpha" })).status).toBe(404);
        expect((await state.fetch(`/comments/${state.seeded.beta.comment}`, { tenant: "beta" })).status).toBe(200);
      });
      test("isolation: a slug of alpha is free in beta", async () => {
        const created = await post(state, "beta", "/notes", { slug: "alpha-note", title: "same slug" });
        expect(created.status).toBe(201);
        expect((await state.fetch(`/notes/${(await json(created)).id}`, { method: "DELETE", tenant: "beta" })).status).toBe(204);
      });
    });

    describe("tenant resolution", () => {
      test("isolation: two tenant headers are refused", async () => {
        const headers = new Headers();
        headers.append("x-tenant-id", "alpha");
        headers.append("x-tenant-id", "beta");
        expect((await state.fetch("/notes", { headers })).status).toBe(400);
      });
      test("isolation: a header with spaces or another case is refused or names exactly one tenant", async () => {
        for (const value of ["Alpha", "ALPHA", "al pha", "alpha beta"]) expect((await state.fetch("/notes", { headers: { "x-tenant-id": value } })).status).toBe(400);
        // Surrounding spaces are not part of a header's value: " alpha " is alpha, and only alpha.
        expect(await json(await state.fetch("/isolation/whoami", { headers: { "x-tenant-id": " alpha " } }))).toEqual({ tenant: "alpha", scope: "tenant:alpha" });
      });
      test("isolation: an encoded path prefix is refused", async () => {
        expect((await state.fetch("/t/%61lpha/notes")).status).toBe(400);
        expect(await slugsByPath(state, "/t/alpha/notes")).toEqual(["alpha-note"]);
      });
      test("isolation: a subdomain with an extra label names no tenant", async () => {
        expect((await state.fetch("/notes", { host: "x.alpha.app.test" })).status).toBe(400);
        expect((await state.fetch("/notes", { host: "beta.app.test" })).status).toBe(200);
      });
      test("isolation: a credential tenant other than the header is refused", async () => {
        expect((await state.fetch("/notes", { tenant: "beta", headers: { "x-credential-tenant": "alpha" } })).status).toBe(403);
      });
    });

    describe("background work", () => {
      test("isolation: a queue message of alpha writes only into alpha", async () => {
        expect((await state.fetch("/isolation/enqueue", { method: "POST", tenant: "alpha" })).status).toBe(200);
        await until(() => state.seen.queue!.length > 0);
        expect(state.seen.queue).toEqual([{ tenant: "alpha", found: null }]);
        expect(await tagNames(state, "alpha")).toContain("from-queue");
        expect(await tagNames(state, "beta")).not.toContain("from-queue");
      });
      test("isolation: listeners and outbox deliveries of alpha's events write only into alpha", async () => {
        expect((await post(state, "alpha", "/notes", { slug: "evented", title: "x" })).status).toBe(201);
        await until(async () => (await tagNames(state, "alpha")).includes("listener:evented") && (await tagNames(state, "alpha")).includes("delivery:evented"), 5000);
        expect(await tagNames(state, "alpha")).toEqual(expect.arrayContaining(["listener:evented", "delivery:evented"]));
        expect(await tagNames(state, "beta")).not.toContain("listener:evented");
        expect(await tagNames(state, "beta")).not.toContain("delivery:evented");
      });
      test("isolation: a per-tenant job writes into each tenant once", async () => {
        const run = await state.app.jobRunner.run({ job: "isolation-job", trigger: "manual", scheduledAt: new Date(), attempt: 1 });
        expect(run?.status).toBe("success");
        expect((await tagNames(state, "alpha")).filter((name) => name.startsWith("from-job"))).toEqual(["from-job-alpha"]);
        expect((await tagNames(state, "beta")).filter((name) => name.startsWith("from-job"))).toEqual(["from-job-beta"]);
      });
      test("isolation: beta's change stream never gets alpha's events", async () => {
        const controller = new AbortController();
        const stream = await state.fetch("/notes/changes", { tenant: "beta", signal: controller.signal });
        const received = readStream(stream);
        await Bun.sleep(100);
        await post(state, "alpha", "/notes", { slug: "streamed-alpha", title: "x" });
        await post(state, "beta", "/notes", { slug: "streamed-beta", title: "x" });
        await until(() => received.text().includes("streamed-beta"), 5000);
        controller.abort();
        expect(received.text()).not.toContain("streamed-alpha");
      });
    });

    describe("caches", () => {
      test("isolation: the directory cache and tenant scopes answer each tenant with its own", async () => {
        for (let round = 0; round < 10; round++) {
          for (const tenant of TENANTS) expect(await json(await state.fetch("/isolation/whoami", { tenant }))).toEqual({ tenant, scope: `tenant:${tenant}` });
        }
      });
      test("isolation: the HTTP client cache keeps private responses per tenant", async () => {
        for (const tenant of [...TENANTS, ...TENANTS]) expect(await json(await state.fetch("/isolation/upstream", { tenant }))).toEqual({ tenant });
      });
      test("isolation: one idempotency key used by both tenants creates a record in each", async () => {
        const call = (tenant: Tenant) =>
          state.fetch("/notes", { method: "POST", tenant, headers: { "content-type": "application/json", "idempotency-key": "isolation-key" }, body: JSON.stringify({ slug: `keyed-${tenant}`, title: "x" }) });
        expect((await call("alpha")).status).toBe(201);
        const second = await call("beta");
        expect([second.status, second.headers.get("idempotent-replayed")]).toEqual([201, null]);
        expect(await slugsAs("beta", "?where[slug][eq]=keyed-beta")).toEqual(["keyed-beta"]);
      });
    });

    if (projectModels.length > 0) {
      describe("project entities", () => {
        for (const model of projectModels) {
          const path = entityRoutePath(model);
          test(`isolation: read and write ${model.entityName} records across tenants`, async () => {
            const ids: Record<string, string> = {};
            for (const tenant of TENANTS) {
              const created = await post(state, tenant, path, sampleBody(model, tenant));
              expect(created.status).toBe(201);
              ids[tenant] = (await json(created)).id as string;
            }
            const listed = ((await json(await state.fetch(path, { tenant: "alpha" }))).data as { id: string }[]).map((record) => record.id);
            expect(listed).toContain(ids.alpha!);
            expect(listed).not.toContain(ids.beta!);
            expect((await state.fetch(`${path}/${ids.beta}`, { tenant: "alpha" })).status).toBe(404);
            expect((await state.fetch(`${path}/${ids.beta}`, { method: "DELETE", tenant: "alpha" })).status).toBe(404);
            expect((await state.fetch(`${path}/${ids.beta}`, { tenant: "beta" })).status).toBe(200);
          });
        }
      });
    }
  });
}

const post = (state: Running, tenant: Tenant, path: string, body: unknown) =>
  state.fetch(path, { method: "POST", tenant, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function slugsByPath(state: Running, path: string): Promise<string[]> {
  return (((await (await state.fetch(path)).json()) as { data: { slug: string }[] }).data ?? []).map((note) => note.slug).sort();
}

async function tagNames(state: Running, tenant: Tenant): Promise<string[]> {
  return runForTenant(tenant, async ({ repos }) => ((await (repos.tags as Repository).list({ where: [], sort: [], limit: 500, offset: 0 })).data as unknown as { name: string }[]).map((tag) => tag.name));
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) return;
    await Bun.sleep(20);
  }
}

/** Reads an event stream in the background, keeping its text so far. */
function readStream(response: Response) {
  let text = "";
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const chunk = await reader!.read();
        if (chunk.done) return;
        text += decoder.decode(chunk.value, { stream: true });
      }
    } catch {
      // The stream ends when the test aborts it.
    }
  })();
  return { text: () => text };
}

/** The generated route entries of the fixture's models, without hooks. */
function crudRoutesOf(models: readonly EntityModel[]): CrudRouteEntry[] {
  const routes: Record<string, { method: string; item: boolean }> = {
    list: { method: "GET", item: false },
    read: { method: "GET", item: true },
    create: { method: "POST", item: false },
    update: { method: "PATCH", item: true },
    replace: { method: "PUT", item: true },
    delete: { method: "DELETE", item: true },
  };
  return models
    .filter((model) => !model.internal)
    .flatMap((model) => CRUD_OPERATIONS.map((operation) => ({ method: routes[operation]!.method, path: routes[operation]!.item ? `${entityRoutePath(model)}/[id]` : entityRoutePath(model), entity: model.key, operation, hooks: [] })));
}

/** Starts the fixture's app on a fresh database with tenants alpha and beta, and seeds both. */
async function startSuite(options: TenantIsolationOptions, projectModels: EntityModel[], prefix: string, suite: number): Promise<Running> {
  const cleanup: (() => Promise<void> | void)[] = [];
  const models = fixtureModels(projectModels);
  const tenantModels = models.filter((model) => model.tenancy === "tenant");
  const sharedModels = models.filter((model) => model.tenancy === "shared");
  const staging = options.strategy === "database" ? stagingModels(models) : [];
  const dir = mkdtempSync(join(tmpdir(), "qs-isolation-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const identifier = (tenant: string) => `${prefix.replaceAll("-", "_")}_${suite}_${tenant}`;
  const schemaOf = (tenant: string) => identifier(tenant).replaceAll("_", "-");
  // The root database and, per tenant, where its tables go.
  let root: DatabaseAdapter;
  const connections: Partial<Record<Tenant, unknown>> = {};
  const prepare: (() => Promise<void>)[] = [];
  /** Drops what the suite created on the database server, before the root adapter disconnects. */
  const drops: (() => Promise<unknown>)[] = [];
  if (options.adapter === "memory") {
    root = memoryAdapter();
    for (const tenant of TENANTS) connections[tenant] = `${identifier(tenant)}-${Bun.randomUUIDv7()}`;
  } else if (options.adapter === "sqlite") {
    const sqlite = sqliteAdapter({ path: join(dir, "root.db") });
    root = sqlite;
    prepare.push(async () => {
      await createSqliteTables(sqlite.client!, sharedModels);
      for (const tenant of TENANTS) {
        if (options.strategy === "schema") await createSqliteTables(sqlite.client!, tenantModels, { defaultSchema: schemaOf(tenant) });
        else {
          const file = sqliteAdapter({ path: join(dir, `${tenant}.db`) });
          await file.connect([...tenantModels, ...staging]);
          await createSqliteTables(file.client!, [...tenantModels, ...staging]);
          await file.disconnect();
        }
      }
    });
    for (const tenant of TENANTS) connections[tenant] = join(dir, `${tenant}.db`);
  } else if (options.adapter === "postgres") {
    const postgres = postgresAdapter({ url: options.url! });
    root = postgres;
    const rootSchema = identifier("root");
    prepare.push(async () => {
      const client = postgres.client!;
      // quickservicets-allow-unsafe: the suite's own schema and database names, built from a checked prefix
      const run = (statement: string) => client.unsafe(statement);
      await run(`drop schema if exists "${rootSchema}" cascade; create schema "${rootSchema}"`);
      for (const statement of await postgresDdl(sharedModels, { defaultSchema: schemaOf("root") })) await run(statement);
      for (const tenant of TENANTS) {
        if (options.strategy === "schema") {
          await run(`drop schema if exists "${identifier(tenant)}" cascade; create schema "${identifier(tenant)}"`);
          for (const statement of await postgresDdl(tenantModels, { defaultSchema: schemaOf(tenant) })) await run(statement);
        } else {
          await run(`drop database if exists "${identifier(tenant)}" with (force)`);
          await run(`create database "${identifier(tenant)}"`);
          const database = postgresAdapter({ url: connections[tenant] as string });
          await database.connect([...tenantModels, ...staging]);
          // quickservicets-allow-unsafe: the DDL drizzle-kit generates from the suite's models
          for (const statement of await postgresDdl([...tenantModels, ...staging])) await database.client!.unsafe(statement);
          await database.disconnect();
        }
      }
      drops.push(async () => {
        await run(`drop schema if exists "${rootSchema}" cascade`);
        for (const tenant of TENANTS) {
          if (options.strategy === "schema") await run(`drop schema if exists "${identifier(tenant)}" cascade`);
          else await run(`drop database if exists "${identifier(tenant)}" with (force)`);
        }
      });
    });
    const base = new URL(options.url!);
    for (const tenant of TENANTS) {
      const url = new URL(base);
      url.pathname = `/${identifier(tenant)}`;
      connections[tenant] = url.href;
    }
  } else {
    const mongo = mongodbAdapter({ url: options.url!, database: identifier("root") });
    root = mongo;
    prepare.push(async () => {
      const client = mongo.client!;
      // A run that stopped early may have left its databases behind.
      await client.db(identifier("root")).dropDatabase();
      for (const model of sharedModels) await mongo.createIndexes(model);
      for (const tenant of TENANTS) {
        const db = client.db(identifier(tenant));
        await db.dropDatabase();
        await db.createCollection(MONGO_MIGRATIONS_COLLECTION);
        const view = options.strategy === "schema" ? mongo.withSchema(schemaOf(tenant)) : undefined;
        for (const model of tenantModels) if (view) await view.createIndexes(model);
      }
      drops.push(async () => {
        for (const tenant of TENANTS) await client.db(identifier(tenant)).dropDatabase();
        await client.db(identifier("root")).dropDatabase();
      });
    });
    for (const tenant of TENANTS) {
      const url = new URL(options.url!);
      url.pathname = `/${identifier(tenant)}`;
      connections[tenant] = url.href;
    }
  }

  // A stand-in for an authentication provider: it sets the credential tenant from x-credential-tenant.
  const credentialKey = `isolation-credentials-${suite}`;
  registerNative(
    defineFeature({
      key: credentialKey,
      docs: { summary: "Sets req.tenant from x-credential-tenant, like an authentication provider." },
      middleware: [
        {
          stage: "handler",
          order: 100,
          run: (req, _res, next) => {
            const credential = req.headers.get("x-credential-tenant");
            if (credential) req.tenant = { id: credential, attributes: {} } as ServiceRequest["tenant"];
            return next();
          },
        },
      ],
    }),
  );
  cleanup.push(() => unregisterNative(credentialKey));

  const upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => Response.json({ tenant: request.headers.get("x-tenant-id") }, { headers: { "cache-control": "private, max-age=60" } }),
  });
  cleanup.push(() => upstream.stop(true));

  const seen: Record<string, unknown[]> = { queue: [] };
  const tenants = Object.fromEntries(
    TENANTS.map((tenant) => [tenant, options.strategy === "schema" ? { schema: schemaOf(tenant) } : { strategy: "database", connection: connections[tenant] }]),
  );
  const config = resolveConfig(
    {
      database: root,
      ...(options.adapter === "postgres" ? { schema: schemaOf("root") } : {}),
      logger: { info() {}, warn() {}, error() {} },
      storage: { default: localStorage({ dir: join(dir, "files") }) },
      files: { access: "proxy" },
      tenancy: { source: "config", strategy: options.strategy, from: ["header", "path", "subdomain"], domain: "app.test", tenants },
      queues: { pollInterval: "10ms" },
      events: { outbox: { delivery: { pollInterval: "10ms" } } },
      realtime: { sse: { pollInterval: "20ms" } },
      idempotency: {},
      http: { allow: ["loopback"], services: { isolation: { url: `http://127.0.0.1:${upstream.port}`, propagate: ["tenant"], cache: { private: true } } } },
      [credentialKey]: {},
    } as unknown as ServiceConfig,
    {},
  );

  const endpoint = (method: string, path: string, handler: Endpoint): AppEndpoint => ({ method, path, hooks: [], handler });
  const repo = (repos: unknown, key: string) => (repos as Record<string, Repository>)[key]!;
  const endpoints: AppEndpoint[] = [
    endpoint("GET", "/isolation/count", async (repos) => ({ notes: await repo(repos, "notes").count(), tags: await repo(repos, "tags").count() })),
    endpoint("GET", "/isolation/related/[id]", async (repos, req) => ({ tags: ((await repo(repos, "notes").related(req.params.id!, "tags" as never).toArray()) as { name: string }[]).map((tag) => tag.name) })),
    endpoint("POST", "/isolation/enqueue", async (_repos, req) => req.queue.add("isolation" as never, { other: (req.tenant as { id: string }).id === "alpha" ? "beta" : "alpha" } as never)),
    endpoint("GET", "/isolation/whoami", (_repos, req) => ({ tenant: (req.tenant as { id: string }).id, scope: currentDatabaseScope().key })),
    endpoint("GET", "/isolation/upstream", (_repos, req) => req.http.service("isolation" as never).get("/who").send()),
  ];
  let betaNote = "";
  const folders = {
    queues: {
      queues: new Map([
        [
          "isolation",
          queue(async (ctx) => {
            const repos = ctx.repos as unknown as RepositoryRegistry;
            seen.queue!.push({ tenant: ctx.tenant?.id, found: await repo(repos, "notes").findById(betaNote) });
            await repo(repos, "tags").create({ name: "from-queue" });
          }),
        ],
      ]),
    },
  };
  const lifecycle = createFeatureLifecycle({ features: config.features, config, models, featureFolders: folders, worker: { index: 0, count: 1, runsScheduledWork: true }, endpoints, crudRoutes: crudRoutesOf(models), generatedDir: join(dir, ".generated") });
  await lifecycle.setup();
  if (options.brokenResolver) {
    // The bug the suite exists to catch: the first request's repositories used for every request.
    let cached: RepositoryRegistry | undefined;
    lifecycle.server.repositories = { owner: "broken", request: () => (cached ??= currentDatabaseScope().repos) };
  }
  await root.connect(models, { defaultSchema: config.schema });
  for (const step of prepare) await step();
  const isolationJob = job({ every: "1h" }, async (ctx) => {
    await repo(ctx.repos, "tags").create({ name: `from-job-${ctx.tenant!.id}` });
  }, { tenants: "each" });
  const app = createApp({ models, crudRoutes: crudRoutesOf(models), endpoints, hooks: new Map(), config, jobs: new Map([["isolation-job", isolationJob]]), featureFolders: folders, runtimeRoutes: lifecycle.routes, middleware: lifecycle.middleware, server: lifecycle.server });
  await lifecycle.start({ repos: app.repos as never, server: app.server });
  const slugOf = (event: unknown) => String(((event as { after?: { slug?: unknown } }).after ?? {}).slug);
  events.on("note.created", async (event) => void (await repo(currentDatabaseScope().repos, "tags").create({ name: `listener:${slugOf(event)}` })));
  events.deliver(`isolation-delivery-${suite}`, { pattern: "note.created", handler: async (event) => void (await repo(currentDatabaseScope().repos, "tags").create({ name: `delivery:${slugOf(event)}` })) });
  cleanup.push(async () => {
    await lifecycle.shutdown();
    await app.shutdown();
    await lifecycle.stop();
    for (const drop of drops) await drop();
    await root.disconnect().catch(() => {});
  });

  const fetch = (path: string, init: RequestInit & { tenant?: Tenant; host?: string } = {}) => {
    const { tenant, host, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (tenant) headers.set("x-tenant-id", tenant);
    return app.server.fetch(new Request(`http://${host ?? "localhost"}${path}`, { ...rest, headers }));
  };
  const running: Running = { app, lifecycle, root, fetch, seeded: {} as Running["seeded"], cleanup, seen, upstream };
  for (const tenant of TENANTS) {
    const created = async (path: string, body: unknown) => ((await (await post(running, tenant, path, body)).json()) as { id: string }).id;
    const form = new FormData();
    form.set("file", new File([fileSamples.png], `${tenant}.png`, { type: "image/png" }));
    const media = ((await (await fetch("/media", { method: "POST", tenant, body: form })).json()) as { id: string }).id;
    const tag = await created("/tags", { name: `${tenant}-tag` });
    const note = await created("/notes", { slug: `${tenant}-note`, title: `${tenant}'s note`, tag, tags: [tag], cover: media });
    const comment = await created("/comments", { text: `${tenant}'s comment`, note });
    running.seeded[tenant] = { tag, note, comment, media, slug: `${tenant}-note` };
  }
  betaNote = running.seeded.beta.note;
  return running;
}

void (null as unknown as SqliteAdapter | PostgresAdapter | MongodbAdapter);
