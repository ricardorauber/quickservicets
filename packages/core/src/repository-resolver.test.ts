import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./index.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { createApp, type App } from "./app.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { builtInFileEntity } from "./files.ts";
import { defineFeature, registerNative, unregisterNative } from "./features.ts";
import { queue } from "./features/queues/index.ts";
import type { Repositories } from "./hooks.ts";
import { job } from "./jobs/job.ts";
import { createFeatureLifecycle, type FeatureLifecycle } from "./lifecycle.ts";
import type { EntityModel } from "./model.ts";
import { configureRepositories, createRepositories, repositoriesFor, repositoryPlans, type Repository, type RepositoryRegistry } from "./repository.ts";
import { setRepositoryResolver, type RunTarget } from "./repository-resolver.ts";
import { localStorage } from "./storage/local.ts";
import { entity, field } from "./testing/entities.ts";
import { fileSamples } from "./testing/file-samples.ts";

const silent = { info() {}, warn() {}, error() {} };
const author = entity("Author", [field({ name: "name", type: "string" })]);
const media = builtInFileEntity("media");
const post = entity("Post", [
  field({ name: "title", type: "string" }),
  field({ name: "author", type: "ref", target: "Author", optional: true } as never),
  field({ name: "cover", type: "ref", target: "Media", optional: true } as never),
]);
const authUser = entity("User", [field({ name: "email", type: "string" })], { schema: "auth", schemaKey: "auth", key: "auth.User", repoKey: "users" });
const models: EntityModel[] = [author, media, post, authUser];

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const repo = (registry: RepositoryRegistry, key: string) => registry[key] as Repository;

describe("repositoriesFor", () => {
  test("builds one registry per adapter instance, with schema-bound repositories nested by schema key", async () => {
    const a = memoryAdapter();
    const b = memoryAdapter();
    await a.connect(models);
    await b.connect(models);
    configureRepositories(models);
    expect(repositoriesFor(a)).toBe(repositoriesFor(a));
    expect(repositoriesFor(a)).not.toBe(repositoriesFor(b));
    const users = (repositoriesFor(a).auth as Record<string, Repository>).users!;
    await users.create({ email: "a@x.test" });
    expect((await users.list({ where: [], sort: [], limit: 10, offset: 0 })).total).toBe(1);
    expect((await (repositoriesFor(b).auth as Record<string, Repository>).users!.list({ where: [], sort: [], limit: 10, offset: 0 })).total).toBe(0);
  });

  test("a second registry reuses the entity plans: no plan or populate projection is built again", async () => {
    const a = memoryAdapter();
    const b = memoryAdapter();
    await a.connect(models);
    await b.connect(models);
    configureRepositories(models, {});
    const plans = spyOn(repositoryPlans, "build");
    repositoriesFor(a);
    const built = plans.mock.calls.length;
    expect(built).toBeGreaterThan(0);
    repositoriesFor(b);
    expect(plans.mock.calls.length).toBe(built);
    plans.mockRestore();
  });
});

/** A service with a test feature that sets `resolver` in its setup, through the feature lifecycle. */
async function start(resolver?: (adapters: { a: ReturnType<typeof memoryAdapter>; b: ReturnType<typeof memoryAdapter> }) => void, extra: Partial<ServiceConfig> = {}) {
  const a = memoryAdapter();
  const b = memoryAdapter();
  await a.connect(models);
  await b.connect(models);
  const dir = mkdtempSync(join(tmpdir(), "qs-resolver-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  registerNative(defineFeature({ key: "test-db", docs: { summary: "Test." }, setup: () => resolver?.({ a, b }) }));
  cleanups.push(() => unregisterNative("test-db"));
  const config = resolveConfig({ database: a, logger: silent, storage: { default: localStorage({ dir }) }, files: { access: "proxy" }, "test-db": {}, ...extra } as ServiceConfig, {});
  const lifecycle: FeatureLifecycle = createFeatureLifecycle({ features: config.features, config, models, worker: { index: 0, count: 1, runsScheduledWork: true } });
  await lifecycle.setup();
  return { a, b, config, lifecycle };
}

function appOf(started: Awaited<ReturnType<typeof start>>, options: { jobs?: Map<string, ReturnType<typeof job>> } = {}): App {
  const crudRoutes = models.flatMap((model) => [
    { method: "GET", path: `/${model.name}`, entity: model.key, operation: "list" as const, hooks: [] },
  ]);
  const app = createApp({
    models,
    crudRoutes,
    endpoints: [],
    hooks: new Map(),
    config: started.config,
    ...(options.jobs ? { jobs: options.jobs } : {}),
    runtimeRoutes: started.lifecycle.routes,
    middleware: started.lifecycle.middleware,
    server: started.lifecycle.server,
  });
  return app;
}

const byHeader = ({ a, b }: { a: ReturnType<typeof memoryAdapter>; b: ReturnType<typeof memoryAdapter> }) =>
  setRepositoryResolver((req) => repositoriesFor(req.headers.get("x-db") === "2" ? b : a));

const send = (app: App, method: string, path: string, init: { body?: unknown; db?: string; form?: FormData } = {}) =>
  app.server.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: { ...(init.db ? { "x-db": init.db } : {}), ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(init.form ? { body: init.form } : init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
  );

describe("the request pipeline with a resolver", () => {
  test("generated routes, uploads, file routes and populate use the registry the resolver returns", async () => {
    const started = await start(byHeader);
    const app = appOf(started);
    const created = await send(app, "POST", "/posts", { body: { title: "second" }, db: "2" });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect((await (await send(app, "GET", "/posts")).json()) as { total: number }).toMatchObject({ total: 0 });
    expect((await (await send(app, "GET", "/posts", { db: "2" })).json()) as { total: number }).toMatchObject({ total: 1 });
    expect((await send(app, "GET", `/posts/${id}`)).status).toBe(404);
    expect((await send(app, "PATCH", `/posts/${id}`, { body: { title: "x" } })).status).toBe(404);
    expect((await send(app, "PATCH", `/posts/${id}`, { body: { title: "renamed" }, db: "2" })).status).toBe(200);

    const writer = await send(app, "POST", "/authors", { body: { name: "Ann" }, db: "2" });
    const authorId = ((await writer.json()) as { id: string }).id;
    const form = new FormData();
    form.set("title", "with cover");
    form.set("author", authorId);
    form.set("cover", new File([fileSamples.png], "cover.png", { type: "image/png" }));
    const uploaded = await send(app, "POST", "/posts?populate=author", { form, db: "2" });
    expect([uploaded.status, uploaded.status === 201 ? "" : await uploaded.text()]).toEqual([201, ""]);
    const withCover = (await uploaded.json()) as { id: string; cover: string };
    expect(await repo(repositoriesFor(started.b), "media").findById(withCover.cover)).not.toBeNull();
    expect(await repo(repositoriesFor(started.a), "media").findById(withCover.cover)).toBeNull();
    const populated = (await (await send(app, "GET", `/posts/${withCover.id}?populate=author`, { db: "2" })).json()) as { author: { name: string } };
    expect(populated.author.name).toBe("Ann");
    expect((await send(app, "GET", `/media/${withCover.cover}/file`)).status).toBe(404);
    const file = await send(app, "GET", `/media/${withCover.cover}/file`, { db: "2" });
    expect([file.status, new Uint8Array(await file.arrayBuffer())]).toEqual([200, fileSamples.png]);
    expect((await send(app, "DELETE", `/posts/${id}`)).status).toBe(404);
    expect((await send(app, "DELETE", `/posts/${id}`, { db: "2" })).status).toBe(204);
  });

  test("custom endpoints and runtime routes receive the resolved registry too", async () => {
    const seen: unknown[] = [];
    const started = await start(byHeader);
    const app = createApp({
      models,
      crudRoutes: [],
      endpoints: [{ method: "GET", path: "/who", hooks: [], handler: (repos) => (seen.push(repos), { ok: true }) }],
      hooks: new Map(),
      config: started.config,
      runtimeRoutes: [{ method: "GET", path: "/runtime", hooks: [], feature: "test-db", handler: (repos) => (seen.push(repos), { ok: true }) }],
      middleware: started.lifecycle.middleware,
      server: started.lifecycle.server,
    });
    await send(app, "GET", "/who", { db: "2" });
    await send(app, "GET", "/runtime");
    expect(seen).toEqual([repositoriesFor(started.b), repositoriesFor(started.a)]);
  });

  test("a second resolver fails the setup naming the first owner, and the function only works during setup", async () => {
    registerNative(defineFeature({ key: "first-db", docs: { summary: "Test." }, setup: () => setRepositoryResolver(() => ({})) }));
    registerNative(defineFeature({ key: "second-db", docs: { summary: "Test." }, after: ["first-db"], setup: () => setRepositoryResolver(() => ({})) }));
    cleanups.push(() => unregisterNative("first-db"), () => unregisterNative("second-db"));
    const config = resolveConfig({ database: memoryAdapter(), logger: silent, "first-db": {}, "second-db": {} } as ServiceConfig, {});
    const lifecycle = createFeatureLifecycle({ features: config.features, config, models, worker: { index: 0, count: 1, runsScheduledWork: true } });
    const failure = await lifecycle.setup().then(() => undefined, (error: Error) => error);
    expect(failure?.message).toBe("second-db failed in setup: A repository resolver is already set by first-db");
    expect(() => setRepositoryResolver(() => ({}))).toThrow("setRepositoryResolver() is only available during feature setup");
  });

  test("without a resolver the server calls none, and every request gets the startup registry", async () => {
    const started = await start();
    expect(started.lifecycle.server.repositories).toBeUndefined();
    const seen: unknown[] = [];
    const app = createApp({
      models,
      crudRoutes: [],
      endpoints: [{ method: "GET", path: "/who", hooks: [], handler: (repos) => (seen.push(repos), { ok: true }) }],
      hooks: new Map(),
      config: started.config,
      server: started.lifecycle.server,
    });
    await send(app, "GET", "/who", { db: "2" });
    expect(seen).toEqual([app.repos]);
  });
});

describe("run repositories", () => {
  test("jobs and queue consumers receive the registry the resolver gives runs", async () => {
    const runs: RunTarget[] = [];
    const seen: Record<string, unknown> = {};
    const started = await start(
      ({ b }) =>
        setRepositoryResolver(() => repositoriesFor(b), {
          run: mock((run: RunTarget) => (runs.push(run), repositoriesFor(b))),
        }),
    );
    const jobs = new Map([["report", job("manual", async (ctx) => void (seen.job = ctx.repos))]]);
    const app = appOf(started, { jobs });
    await app.jobRunner.run({ job: "report", trigger: "manual", scheduledAt: new Date(), attempt: 1 });
    expect(seen.job).toBe(repositoriesFor(started.b));
    expect(runs[0]).toMatchObject({ job: { name: "report" } });

    const { consumerHandler } = await import("./features/queues/handle.ts");
    const { resolveRunRepositories } = await import("./repository-resolver.ts");
    const handle = consumerHandler({
      definitions: new Map([["mail", queue(async (ctx) => void (seen.consumer = ctx.repos))]]),
      repos: () => app.repos as unknown as Repositories,
      runRepositories: (run) => resolveRunRepositories(run) as unknown as Repositories,
      logger: silent,
    });
    await handle({ id: "m1", queue: "mail", payload: {}, attempt: 1, enqueuedAt: new Date().toISOString() } as never, { signal: new AbortController().signal } as never);
    expect(seen.consumer).toBe(repositoriesFor(started.b));
    expect(runs[1]).toEqual({ queue: { name: "mail", messageId: "m1" } });
  });

  test("without a resolver, runs get the startup registry", async () => {
    const started = await start();
    const seen: Record<string, unknown> = {};
    const app = appOf(started, { jobs: new Map([["report", job("manual", async (ctx) => void (seen.job = ctx.repos))]]) });
    await app.jobRunner.run({ job: "report", trigger: "manual", scheduledAt: new Date(), attempt: 1 });
    expect(seen.job).toBe(app.repos);
  });

  test("createRepositories still builds independent registries", async () => {
    const adapter = memoryAdapter();
    await adapter.connect(models);
    expect(createRepositories(models, adapter)).not.toBe(createRepositories(models, adapter));
  });
});
