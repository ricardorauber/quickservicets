import { describe, expect, test } from "bun:test";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { createFeatureLifecycle } from "./lifecycle.ts";
import type { ConnectionPoolSettings, DatabaseAdapter } from "./adapter.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { postgresAdapter } from "./adapters/postgres.ts";
import { migrationConfig, withSourceDrivers } from "./migration-runner.ts";
import { dbCheckCommand } from "./features/connections/check.ts";
import { postgresDdl, recordStatements } from "./testing/postgres.ts";
import { entity, field } from "./testing/entities.ts";
import type { CommandContext } from "./commands.ts";
import "./index.ts";

const quiet = { info() {}, warn() {}, error() {} };
const postgresUrl = process.env.TEST_POSTGRES_URL;
/** A URL nothing answers on, standing for the proxy where only the direct connection may be used. */
const UNREACHABLE = "postgres://app:proxy-password@127.0.0.1:1/app";

/** Records the pool settings an adapter receives, over a PostgreSQL adapter that is never connected. */
const spyPostgres = (url = UNREACHABLE) => {
  const calls: ConnectionPoolSettings[] = [];
  const adapter = postgresAdapter({ url });
  const configure = adapter.configurePool!.bind(adapter);
  adapter.configurePool = (settings) => {
    calls.push(settings);
    configure(settings);
  };
  return { adapter, calls };
};

/** Resolves a config and runs the features' setups, as a service does before connecting. */
async function setUp(config: Record<string, unknown>) {
  const resolved = resolveConfig({ logger: quiet, ...config } as ServiceConfig, {});
  const lifecycle = createFeatureLifecycle({ features: resolved.features, config: resolved, models: [], worker: { index: 0, count: 1, runsScheduledWork: false } });
  try {
    await lifecycle.setup();
  } finally {
    await lifecycle.stop();
  }
  return resolved;
}

const withoutReport = (calls: ConnectionPoolSettings[]) => calls.map(({ onReconnect: _, ...settings }) => settings);

describe("statement options per proxy", () => {
  test("pgbouncer and rds-proxy turn prepared statements off, rds-proxy also requires TLS; no proxy changes nothing", async () => {
    const pgbouncer = spyPostgres();
    await setUp({ database: pgbouncer.adapter, connections: { proxy: "pgbouncer" } });
    expect(withoutReport(pgbouncer.calls)).toEqual([{ prepare: false }]);
    const rds = spyPostgres("postgres://app:secret@proxy.example.com/app?sslmode=require");
    await setUp({ database: rds.adapter, connections: { proxy: "rds-proxy" } });
    expect(withoutReport(rds.calls)).toEqual([{ prepare: false, tls: true }]);
    const none = spyPostgres();
    await setUp({ database: none.adapter });
    expect(none.calls).toEqual([]);
    // A proxy stands in front of PostgreSQL only.
    const memory = Object.assign(memoryAdapter(), { configurePool: () => {} }) as DatabaseAdapter;
    await setUp({ database: memory, connections: { proxy: "pgbouncer" } });
  });

  test.skipIf(!postgresUrl)("the PostgreSQL adapter passes prepare: false and sends no SET", async () => {
    const adapter = postgresAdapter({ url: postgresUrl! });
    adapter.configurePool!({ prepare: false });
    const Post = entity("ProxyPost", [field({ name: "title", type: "string" })]);
    await adapter.connect([Post], {});
    try {
      expect((adapter.client as unknown as { options: { prepare: boolean } }).options.prepare).toBe(false);
      await adapter.client!.unsafe('drop table if exists "proxyposts"');
      // quickservicets-allow-unsafe: runs the DDL drizzle-kit generates from the model
      for (const statement of await postgresDdl([Post])) await adapter.client!.unsafe(statement);
      const log = recordStatements(adapter.client!);
      const at = new Date();
      const id = Bun.randomUUIDv7();
      await adapter.insert(Post, { id, title: "One", createdAt: at, updatedAt: at });
      await adapter.updateById(Post, id, { title: "Two", updatedAt: at });
      expect((await adapter.findById(Post, id))?.title).toBe("Two");
      await adapter.deleteById(Post, id);
      expect(log.statements.some((statement) => /^\s*set\s/i.test(statement))).toBe(false);
      await adapter.client!.unsafe('drop table "proxyposts"');
    } finally {
      await adapter.disconnect();
    }
  });
});

describe("session features and the direct connection", () => {
  const realtime = { websockets: { transport: "postgres" } };

  test("the PostgreSQL socket transport behind a proxy needs connections.direct", async () => {
    await expect(setUp({ database: spyPostgres().adapter, realtime, connections: { proxy: "pgbouncer" } })).rejects.toThrow(
      "realtime needs a direct connection because LISTEN does not work through PgBouncer; set connections.direct",
    );
    const { adapter, calls } = spyPostgres();
    await setUp({ database: adapter, realtime, connections: { proxy: "pgbouncer", direct: "postgres://app:direct-password@db.internal/app" } });
    expect(calls[0]).toMatchObject({ prepare: false, direct: "postgres://app:direct-password@db.internal/app" });
    // Without a proxy the transport listens on the database URL as before.
    await setUp({ database: spyPostgres().adapter, realtime });
  });

  test.skipIf(!postgresUrl)("LISTEN opens on the direct connection, not the proxy's", async () => {
    const adapter = postgresAdapter({ url: UNREACHABLE });
    adapter.configurePool!({ prepare: false, direct: postgresUrl! });
    const received: string[] = [];
    let listening!: () => void;
    const ready = new Promise<void>((resolve) => (listening = resolve));
    const unlisten = await adapter.listen!("qs_proxy_direct", (payload) => void received.push(payload), () => listening());
    try {
      await ready;
      const sender = new Bun.SQL({ url: postgresUrl!, max: 1 });
      await sender`select pg_notify('qs_proxy_direct', 'hello')`;
      await sender.close();
      for (let attempt = 0; attempt < 50 && received.length === 0; attempt++) await Bun.sleep(20);
      expect(received).toEqual(["hello"]);
    } finally {
      await unlisten();
    }
  });
});

describe("migrations and TLS checks", () => {
  test("migrate connects to connections.direct when it is set", async () => {
    const connected: string[] = [];
    const proxy = postgresAdapter({ url: UNREACHABLE });
    proxy.forConnection = (connection) => {
      connected.push(String(connection));
      return Object.assign(memoryAdapter(), {
        kind: "postgres",
        connect: async () => {
          throw new Error("connected to the direct database");
        },
      }) as never;
    };
    const config = resolveConfig({ logger: quiet, database: proxy, connections: { proxy: "pgbouncer", direct: "postgres://app:pw@db.internal/app" } } as ServiceConfig, {});
    const source = { config, models: [], files: () => [], load: async () => ({}) as never };
    await expect(withSourceDrivers(source, async () => "ran")).rejects.toThrow("connected to the direct database");
    expect(connected).toEqual(["postgres://app:pw@db.internal/app"]);
    // Without direct, migrations use the database as configured.
    const plain = resolveConfig({ logger: quiet, database: proxy, connections: { proxy: "pgbouncer" } } as ServiceConfig, {});
    expect(migrationConfig(plain).database).toBe(proxy);
  });

  test("rds-proxy with sslmode=disable fails at startup", async () => {
    await expect(setUp({ database: postgresAdapter({ url: "postgres://app:pw@proxy.example.com/app?sslmode=disable" }), connections: { proxy: "rds-proxy" } })).rejects.toThrow(
      "RDS Proxy needs TLS; add sslmode=require to the database URL",
    );
    await setUp({ database: postgresAdapter({ url: "postgres://app:pw@proxy.example.com/app?sslmode=disable" }), connections: { proxy: "pgbouncer" } });
  });
});

describe("db check", () => {
  /** Runs `db check` with a config, returning its exit code and printed lines. */
  async function dbCheck(config: Record<string, unknown>) {
    const resolved = resolveConfig({ logger: quiet, ...config } as ServiceConfig, {});
    const lines: string[] = [];
    const options = resolved.features.find((feature) => feature.key === "connections")!.options;
    const ctx = { args: {}, flags: {}, cwd: process.cwd(), config: resolved, options, json: false, output: { log: (line: string) => void lines.push(line), error: (line: string) => void lines.push(line) } };
    const code = await dbCheckCommand.run(ctx as unknown as CommandContext);
    return { code: code ?? 0, lines, text: lines.join("\n") };
  }

  test.skipIf(!postgresUrl)("prints the version, pool settings and connection counts, and exits 1 listing a session feature without direct", async () => {
    const password = decodeURIComponent(new URL(postgresUrl!).password);
    const ok = await dbCheck({ database: postgresAdapter({ url: postgresUrl! }), connections: { max: 5, idleTimeout: "10s" } });
    expect(ok.code).toBe(0);
    expect(ok.text).toMatch(/^database: PostgreSQL \d+/m);
    expect(ok.lines).toContain("pool: max 5, idleTimeout 10s");
    expect(ok.text).toMatch(/^max_connections: \d+$/m);
    expect(ok.text).toMatch(/^connections: \d+ open$/m);
    expect(ok.lines).toContain("direct: not set");
    const failing = await dbCheck({ database: postgresAdapter({ url: postgresUrl! }), realtime: { websockets: { transport: "postgres" } }, connections: { proxy: "pgbouncer" } });
    expect(failing.code).toBe(1);
    expect(failing.lines).toContain("problem: realtime needs a direct connection because LISTEN does not work through PgBouncer; set connections.direct");
    expect(failing.lines).toContain("pool: prepare false");
    const direct = await dbCheck({ database: postgresAdapter({ url: postgresUrl! }), connections: { proxy: "pgbouncer", direct: postgresUrl! } });
    expect(direct.code).toBe(0);
    expect(direct.lines).toContain("direct: works");
    for (const run of [ok, failing, direct]) if (password) expect(run.text).not.toContain(password);
  });

  test("an unreachable database or direct connection exits 1 without printing the password", async () => {
    const run = await dbCheck({ database: postgresAdapter({ url: UNREACHABLE }), connections: { proxy: "pgbouncer", direct: "postgres://app:direct-password@127.0.0.1:1/app" } });
    expect(run.code).toBe(1);
    expect(run.text).toContain("database: postgres cannot be reached");
    expect(run.text).toMatch(/^direct: fails/m);
    expect(run.text).not.toContain("proxy-password");
    expect(run.text).not.toContain("direct-password");
  });
});
