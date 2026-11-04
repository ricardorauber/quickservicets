import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFeatureLifecycle, importConfigFile, memoryAdapter, registerProjectFeatures, resolveConfig, type ConnectionPoolSettings, type DatabaseAdapter, type InfraService } from "@quickservicets/core";
import { describeWithServices, startTestService } from "@quickservicets/cli/testing";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const files = () => ({ "quickservicets.config.ts": read("quickservicets.config.ts"), "entities/Post.ts": read("entities/Post.ts") });
const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** The pool settings the example's database gets on a deploy target, read through a memory adapter spy. */
async function poolOn(target: string, env: Record<string, string> = {}) {
  const calls: ConnectionPoolSettings[] = [];
  const warnings: string[] = [];
  const spy = Object.assign(memoryAdapter(), { configurePool: (settings: ConnectionPoolSettings) => void calls.push(settings) }) as DatabaseAdapter;
  const project = await importConfigFile(root);
  // Only this project's features: a service started earlier in the same test process may have registered others.
  registerProjectFeatures([]);
  const logger = { info() {}, error() {}, warn: (entry: { message?: unknown }) => void warnings.push(String(entry.message)) };
  const config = resolveConfig({ ...project, database: spy, logger, deploy: { target } } as never, env);
  const lifecycle = createFeatureLifecycle({ features: config.features, config, models: [], worker: { index: 0, count: 1, runsScheduledWork: false } });
  await lifecycle.setup();
  await lifecycle.stop();
  return { settings: calls.map(({ onReconnect: _, ...settings }) => settings)[0], warnings };
}

test("lambda and azure-functions get small lazy pools, servers keep the adapter's, and QS_CONNECTIONS_MAX sets max", async () => {
  const serverless = { max: 2, idleTimeout: "30s", maxLifetime: "15m", connectTimeout: "5s", lazy: true };
  expect((await poolOn("lambda")).settings).toEqual(serverless);
  expect((await poolOn("azure-functions")).settings).toEqual(serverless);
  expect((await poolOn("server")).settings).toBeUndefined();
  expect((await poolOn("cloud-run")).settings).toBeUndefined();
  expect((await poolOn("lambda", { QS_CONNECTIONS_MAX: "3" })).settings).toMatchObject({ max: 3, lazy: true });
  // 2 connections × 1 worker × 10 instances stays within the budget of 100; 20 per instance does not.
  expect((await poolOn("lambda")).warnings).toEqual([]);
  expect((await poolOn("server", { QS_CONNECTIONS_MAX: "20" })).warnings).toContain("connections may reach 200, above connections.budget 100; lower connections.max or use a connection proxy");
});

test("the project serves its posts", async () => {
  const service = await startTestService({ files: files() });
  try {
    expect((await service.fetch("/posts", json({ title: "Pooled" }))).status).toBe(201);
  } finally {
    await service.stop();
  }
});

/** PgBouncer in transaction mode in front of the catalog's PostgreSQL, in the same compose project. */
const pgbouncer: InfraService = {
  name: "pgbouncer",
  kind: "custom",
  description: "PgBouncer in transaction mode.",
  image: "edoburu/pgbouncer:v1.24.1-p1",
  ports: [5432],
  health: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -p 5432"],
  credentials: { user: "postgres", password: "postgres", database: "app" },
  environment: { DATABASE_URL: "postgres://postgres:postgres@postgres:5432/app", POOL_MODE: "transaction", AUTH_TYPE: "scram-sha-256", LISTEN_PORT: "5432" },
  env: { PGBOUNCER_URL: "postgres://{user}:{password}@{host}:{port}/{database}" },
  optional: false,
  owners: ["example"],
};

// Both run in containers, even when TEST_POSTGRES_URL points at a server, so PgBouncer reaches PostgreSQL by name.
describeWithServices(
  ["postgres", "pgbouncer"],
  (services) => {
    test("the CRUD flow runs through PgBouncer with proxy pgbouncer, migrations on the direct connection", async () => {
      // The migration step reads the process's environment, like `quickservicets migrate`.
      const variables = { QS_CONNECTIONS_PROXY: "pgbouncer", QS_CONNECTIONS_DIRECT: services.urls.postgres! };
      const previous = Object.fromEntries(Object.keys(variables).map((name) => [name, process.env[name]]));
      Object.assign(process.env, variables);
      try {
        const service = await startTestService({ files: files(), services: ["postgres"], env: { ...variables, TEST_POSTGRES_URL: services.urls.pgbouncer! } });
        try {
          const created = await service.fetch("/posts", json({ title: "Through the proxy" }));
          expect(created.status).toBe(201);
          const { id } = (await created.json()) as { id: string };
          expect(((await (await service.fetch(`/posts/${id}`)).json()) as { title: string }).title).toBe("Through the proxy");
          expect((await service.fetch(`/posts/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Renamed" }) })).status).toBe(200);
          expect(((await (await service.fetch("/posts")).json()) as { total: number }).total).toBe(1);
          expect((await service.fetch(`/posts/${id}`, { method: "DELETE" })).status).toBe(204);
        } finally {
          await service.stop();
        }
      } finally {
        for (const [name, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    }, 120_000);
  },
  { services: [pgbouncer], env: { ...process.env, TEST_POSTGRES_URL: undefined } },
);
