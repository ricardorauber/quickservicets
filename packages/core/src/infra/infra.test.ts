import { afterEach, describe, expect, spyOn, test } from "bun:test";
import net from "node:net";
import { resolveConfig, type ServiceConfig } from "../config.ts";
import { defineFeature, registerNative, unregisterNative } from "../features.ts";
import { memoryAdapter } from "../adapters/memory.ts";
import { postgresAdapter } from "../adapters/postgres.ts";
import { sqliteAdapter } from "../adapters/sqlite.ts";
import { mongodbAdapter } from "../adapters/mongodb.ts";
import { s3Storage } from "../storage/s3.ts";
import { catalogProblems, INFRA_CATALOG, INFRA_KINDS } from "./catalog.ts";
import { describeInfrastructure, resolveInfraTemplate } from "./describe.ts";

const quiet = { info() {}, warn() {}, error() {} };
const registered: string[] = [];
const register = (definition: ReturnType<typeof defineFeature>) => {
  registerNative(definition);
  registered.push(definition.key);
  return definition;
};
afterEach(() => {
  for (const key of registered.splice(0)) unregisterNative(key);
});
const resolve = (config: Record<string, unknown>) => resolveConfig({ logger: quiet, ...config } as ServiceConfig, {});

const cache = () =>
  defineFeature({
    key: "test-cache",
    docs: { summary: "Test native." },
    infra: [{ name: "redis", kind: "redis", description: "Cache", env: { REDIS_URL: "redis://{host}:{port}" } }],
  });

describe("requirements", () => {
  test("a well-formed requirement registers, and a custom one without image fails naming it", () => {
    expect(cache().infra).toEqual([{ name: "redis", kind: "redis", description: "Cache", env: { REDIS_URL: "redis://{host}:{port}" } }]);
    expect(() => defineFeature({ key: "broken", infra: [{ name: "thing", kind: "custom", description: "A thing", env: {}, ports: [80] }] })).toThrow("Invalid infra thing of broken: a custom requirement needs image");
    expect(() => defineFeature({ key: "broken", infra: [{ name: "thing", kind: "custom", description: "A thing", env: {}, image: "thing:1.0" }] })).toThrow("Invalid infra thing of broken: a custom requirement needs ports");
  });

  test("names, kinds, variable names and placeholders are checked", () => {
    const failing = (requirement: Record<string, unknown>) => () => defineFeature({ key: "broken", infra: [{ name: "redis", kind: "redis", description: "Cache", env: {}, ...requirement } as never] });
    expect(failing({ name: "Redis" })).toThrow("Invalid infra Redis of broken: the name must match ^[a-z][a-z0-9-]*$");
    expect(failing({ kind: "memcached" })).toThrow('Invalid infra redis of broken: unknown kind "memcached"; use a catalog kind or custom');
    expect(failing({ env: { redis_url: "x" } })).toThrow("Invalid infra redis of broken: invalid variable name redis_url: use ^[A-Z][A-Z0-9_]*$");
    expect(failing({ env: { REDIS_URL: "redis://{hostname}:{port}" } })).toThrow("Invalid infra redis of broken: unknown placeholder {hostname} in REDIS_URL");
    expect(failing({ env: { REDIS_URL: "redis://{host}:{port:7000}" } })).toThrow("Invalid infra redis of broken: REDIS_URL uses {port:7000}, which is not a port of the service");
    expect(() => defineFeature({ key: "custom", infra: [{ name: "echo", kind: "custom", description: "Echo", image: "echo:1.2", ports: [7000, 7001], env: { ECHO_URL: "http://{host}:{port:7001}" } }] })).not.toThrow();
  });

  test("templates resolve every placeholder with the mapped ports and the credentials", () => {
    const service = { ports: [5432], credentials: { user: "postgres", password: "p@ss", database: "app" } };
    expect(resolveInfraTemplate("postgres://{user}:{password}@{host}:{port}/{database}", service, { host: "localhost", ports: { 5432: 55001 } })).toBe("postgres://postgres:p%40ss@localhost:55001/app");
    expect(resolveInfraTemplate("smtp://{host}:{port:1025}", { ports: [1025, 8025], credentials: {} }, { host: "127.0.0.1", ports: { 1025: 2525 } })).toBe("smtp://127.0.0.1:2525");
  });
});

describe("the catalog", () => {
  test("every kind has a pinned image, ports and a health command", () => {
    expect(Object.keys(INFRA_CATALOG).sort()).toEqual([...INFRA_KINDS].sort());
    expect(catalogProblems()).toEqual([]);
    for (const kind of INFRA_KINDS) {
      const entry = INFRA_CATALOG[kind];
      expect(entry.image).toMatch(/:[^/:]+$/);
      expect(entry.ports.length).toBeGreaterThan(0);
      expect(entry.health.length).toBeGreaterThan(1);
    }
  });

  test("an entry with the tag latest or without a health command fails the check", () => {
    const entry = INFRA_CATALOG.redis;
    expect(catalogProblems({ redis: { ...entry, image: "redis:latest" } })).toEqual(["redis: redis:latest uses the tag latest; pin an exact version"]);
    expect(catalogProblems({ redis: { ...entry, image: "redis" } })).toEqual(["redis: redis has no tag"]);
    expect(catalogProblems({ redis: { ...entry, health: [] } })).toEqual(["redis: missing health command"]);
  });
});

describe("describing a configuration", () => {
  test("the database, an S3 storage without endpoint and a feature's requirements become services and variables", () => {
    register(cache());
    const config = resolve({ database: postgresAdapter({ url: "postgres://localhost/app" }), storage: { default: s3Storage({ bucket: "uploads" }) }, "test-cache": {} });
    const described = describeInfrastructure(config as never);
    expect(described.services.map((service) => service.kind)).toEqual(["postgres", "minio", "redis"]);
    expect(Object.keys(described.env).sort()).toEqual(["DATABASE_URL", "REDIS_URL", "S3_ACCESS_KEY_ID", "S3_ENDPOINT", "S3_REGION", "S3_SECRET_ACCESS_KEY"]);
    expect(described.services[0]).toMatchObject({ name: "database", image: INFRA_CATALOG.postgres.image, owners: ["database"] });
    expect(described.services[1]!.environment.QS_BUCKETS).toBe("uploads");
    const sqlite = describeInfrastructure(resolve({ database: sqliteAdapter({ path: ":memory:" }), "test-cache": {} }) as never);
    expect(sqlite.services.map((service) => service.kind)).toEqual(["redis"]);
  });

  test("an S3 storage with an explicit endpoint needs no local service", () => {
    const described = describeInfrastructure(resolve({ storage: { default: s3Storage({ bucket: "uploads", endpoint: "https://r2.example.com" }) } }) as never);
    expect(described.services).toEqual([]);
  });

  test("two features needing redis share one service; different templates for one variable fail", () => {
    register(cache());
    register(defineFeature({ docs: { summary: "Test native." }, key: "test-sessions", infra: [{ name: "redis", kind: "redis", description: "Sessions", env: { REDIS_URL: "redis://{host}:{port}" }, optional: true }] }));
    const shared = describeInfrastructure(resolve({ "test-cache": {}, "test-sessions": {} }) as never);
    expect(shared.services).toHaveLength(1);
    expect(shared.services[0]!.owners).toEqual(["test-cache", "test-sessions"]);
    expect(shared.services[0]!.optional).toBe(false);
    unregisterNative("test-sessions");
    registered.pop();
    register(defineFeature({ docs: { summary: "Test native." }, key: "test-sessions", infra: [{ name: "redis", kind: "redis", description: "Sessions", env: { REDIS_URL: "redis://{host}:{port}/1" } }] }));
    expect(() => describeInfrastructure(resolve({ "test-cache": {}, "test-sessions": {} }) as never)).toThrow("REDIS_URL is set by test-cache and by test-sessions");
  });

  test("optional requirements are listed as optional, function forms see the options and are checked", () => {
    register(
      defineFeature({
        key: "test-search",
        docs: { summary: "Test native." },
        infra: ({ options }) => [{ name: "search", kind: (options as { engine?: string }).engine === "bad" ? "nope" : "meilisearch", description: "Search", env: { SEARCH_URL: "http://{host}:{port}" }, optional: true } as never],
      }),
    );
    const described = describeInfrastructure(resolve({ "test-search": {} }) as never);
    expect(described.services[0]).toMatchObject({ name: "search", kind: "meilisearch", optional: true });
    unregisterNative("test-search");
    registered.pop();
    register(defineFeature({ docs: { summary: "Test native." }, key: "test-search", infra: () => [{ name: "search", kind: "nope", description: "Search", env: {} } as never] }));
    expect(() => describeInfrastructure(resolve({ "test-search": {} }) as never)).toThrow('Invalid infra search of test-search: unknown kind "nope"; use a catalog kind or custom');
  });

  test("describing opens no socket, and a running service never reads infra", async () => {
    let calls = 0;
    register(defineFeature({ docs: { summary: "Test native." }, key: "test-watched", infra: () => (calls++, [{ name: "redis", kind: "redis", description: "Cache", env: { REDIS_URL: "redis://{host}:{port}" } }]) }));
    const connect = spyOn(net, "connect");
    const createConnection = spyOn(net, "createConnection");
    const bunConnect = spyOn(Bun, "connect");
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      describeInfrastructure(resolve({ database: postgresAdapter({ url: "postgres://localhost/app" }), "test-watched": {} }) as never);
      expect(calls).toBe(1);
      expect(connect).not.toHaveBeenCalled();
      expect(createConnection).not.toHaveBeenCalled();
      expect(bunConnect).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
      createConnection.mockRestore();
      bunConnect.mockRestore();
      fetchSpy.mockRestore();
    }
    const { createApp } = await import("../index.ts");
    const config = resolve({ "test-watched": {} });
    await config.database.connect([], {});
    const app = createApp({ models: [], crudRoutes: [], endpoints: [], hooks: new Map(), config });
    expect((await app.server.fetch(new Request("http://localhost/nothing"))).status).toBe(404);
    expect(calls).toBe(1);
  });
});

describe("named databases", () => {
  test("each database served by PostgreSQL or MongoDB gets a service with its variable; memory and SQLite add none", () => {
    const config = resolve({
      database: postgresAdapter({ url: "postgres://localhost/app" }),
      databases: { catalog: mongodbAdapter({ url: "mongodb://localhost", database: "catalog" }), cache: memoryAdapter(), local: sqliteAdapter({ path: ":memory:" }) },
    });
    const described = describeInfrastructure(config as never);
    expect(described.services.map((service) => [service.name, service.kind])).toEqual([
      ["database", "postgres"],
      ["database-catalog", "mongodb"],
    ]);
    expect(described.env).toEqual({
      DATABASE_URL: INFRA_CATALOG.postgres.templates.DATABASE_URL!,
      QS_DATABASES_CATALOG_URL: INFRA_CATALOG.mongodb.templates.DATABASE_URL!,
    });
  });
});
