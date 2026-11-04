import { describe, expect, test } from "bun:test";
import "./index.ts";
import { readFileSync, rmSync, mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UniqueViolationError } from "./adapter.ts";
import { postgresAdapter } from "./adapters/postgres.ts";
import { createApp } from "./app.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { entity, field } from "./testing/entities.ts";
import { createFeatureLifecycle } from "./lifecycle.ts";
import { postgresDdl } from "./testing/postgres.ts";
import { runSqlExecutorContract } from "./testing/sql-executor-contract.ts";
import { bunSqlExecutor, type SqlExecutor, type SqlExecutorCapabilities } from "./sql-executor.ts";

const postgresUrl = process.env.TEST_POSTGRES_URL;
const quiet = { info() {}, warn() {}, error() {} };

/** An executor answering every statement with `answer`, recording what it receives. */
function fakeExecutor(answer: (text: string, params: readonly unknown[]) => Record<string, unknown>[] | Promise<Record<string, unknown>[]>, capabilities: Partial<SqlExecutorCapabilities> = {}) {
  const statements: string[] = [];
  const executor: SqlExecutor = {
    name: "fake",
    capabilities: { interactiveTransactions: true, listen: true, preparedStatements: false, ...capabilities },
    async query(text, params) {
      statements.push(text);
      return answer(text, params);
    },
    transaction: (fn) => fn(executor),
    close: async () => {},
  };
  return { executor, statements };
}

/** Records the statements of another executor, transactions included. */
function recording(inner: SqlExecutor, statements: string[]): SqlExecutor {
  return {
    name: "recording",
    capabilities: inner.capabilities,
    query(text, params, options) {
      statements.push(text);
      return inner.query(text, params, options);
    },
    transaction: (fn) => inner.transaction((tx) => fn(recording(tx, statements))),
    close: () => inner.close(),
  };
}

const Post = entity("Post", [field({ name: "title", type: "string" }), field({ name: "views", type: "number", optional: true })]);

describe("executor routing", () => {
  test.skipIf(!postgresUrl)("the insert of POST /posts and the select of GET /posts/[id] reach the executor", async () => {
    const statements: string[] = [];
    const pool = new Bun.SQL({ url: postgresUrl!, max: 2 });
    await pool.unsafe('drop table if exists "posts" cascade');
    // quickservicets-allow-unsafe: runs the DDL drizzle-kit generates from the model
    for (const statement of await postgresDdl([Post])) await pool.unsafe(statement);
    const adapter = postgresAdapter({ executor: recording(bunSqlExecutor(pool), statements) });
    await adapter.connect([Post]);
    try {
      const config = resolveConfig({ database: adapter, logger: quiet, security: false } as ServiceConfig, {});
      const app = createApp({ models: [Post], crudRoutes: [], endpoints: [], hooks: new Map(), config });
      const created = await app.server.fetch(new Request("http://localhost/posts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Hello" }) }));
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as { id: string };
      expect(statements.some((text) => /^insert into "posts"/i.test(text))).toBe(true);
      statements.length = 0;
      const read = await app.server.fetch(new Request(`http://localhost/posts/${id}`));
      expect(((await read.json()) as { title: string }).title).toBe("Hello");
      expect(statements.some((text) => /^select .* from "posts"/i.test(text))).toBe(true);
      // Aggregates, counts, ping and the client others use (migrations, renames) go through it too.
      statements.length = 0;
      await adapter.count(Post, []);
      await adapter.aggregate!(Post, [], { views: { fn: "sum", field: "views" } });
      await adapter.ping!();
      await adapter.client!.unsafe("select 1 as one");
      await adapter.transaction!(async () => {
        await adapter.findById(Post, id);
      });
      expect(statements.length).toBeGreaterThanOrEqual(5);
      expect(statements).toContain("select 1");
      expect(statements).toContain("select 1 as one");
    } finally {
      await adapter.disconnect();
      await new Bun.SQL({ url: postgresUrl!, max: 1 }).unsafe('drop table if exists "posts" cascade').catch(() => {});
    }
  });

  test.skipIf(!postgresUrl)("without an executor, the adapter's statements go through the built-in one", async () => {
    const adapter = postgresAdapter({ url: postgresUrl! });
    await adapter.connect([]);
    try {
      expect(adapter.executor?.name).toBe("bun-sql");
      await adapter.ping!();
    } finally {
      await adapter.disconnect();
    }
  });
});

describe("capability checks", () => {
  async function setUp(config: Record<string, unknown>) {
    const resolved = resolveConfig({ logger: quiet, ...config } as ServiceConfig, {});
    const lifecycle = createFeatureLifecycle({ features: resolved.features, config: resolved, models: [], worker: { index: 0, count: 1, runsScheduledWork: false } });
    try {
      await lifecycle.setup();
    } finally {
      await lifecycle.stop();
    }
  }

  test("the PostgreSQL socket transport on an executor without listen fails startup", async () => {
    const { executor } = fakeExecutor(() => [], { listen: false });
    await expect(setUp({ database: postgresAdapter({ executor }), realtime: { websockets: { transport: "postgres" } } })).rejects.toThrow("realtime needs listen, which the fake executor does not support");
    await setUp({ database: postgresAdapter({ executor }) });
  });

  test("a transaction on an executor without interactive transactions fails with the capability", async () => {
    const { executor } = fakeExecutor(() => [], { interactiveTransactions: false });
    const adapter = postgresAdapter({ executor });
    await adapter.connect([]);
    await expect(adapter.transaction!(async () => "never")).rejects.toThrow("transaction needs interactiveTransactions, which the fake executor does not support");
    await adapter.disconnect();
  });
});

describe("error mapping through executors", () => {
  test("an executor error with code 23505 and a constraint becomes a UniqueViolationError on its field", async () => {
    const Item = entity("Item", [field({ name: "title", type: "string" }), field({ name: "code", type: "string", unique: true })]);
    const { executor } = fakeExecutor(() => {
      throw Object.assign(new Error('duplicate key value violates unique constraint "items_code_uq"'), { code: "23505", constraint: "items_code_uq" });
    });
    const adapter = postgresAdapter({ executor });
    await adapter.connect([Item]);
    const at = new Date();
    const error = await adapter.insert(Item, { id: "a", title: "A", code: "same", createdAt: at, updatedAt: at }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UniqueViolationError);
    expect((error as UniqueViolationError).field).toBe("code");
    await adapter.disconnect();
  });

  test.skipIf(!postgresUrl)("the built-in executor reports the SQLSTATE as code", async () => {
    const executor = bunSqlExecutor(new Bun.SQL({ url: postgresUrl!, max: 1 }));
    try {
      const error = await executor.query("select * from qs_no_such_table", []).catch((caught: unknown) => caught);
      expect((error as { code?: string }).code).toBe("42P01");
    } finally {
      await executor.close();
    }
  });
});

describe("contract registration and skipping", () => {
  runSqlExecutorContract((url) => bunSqlExecutor(new Bun.SQL({ url, max: 4 })), { name: "bun-sql" });

  test("without its variable the contract is one named skipped test", () => {
    const dir = mkdtempSync(join(tmpdir(), "qs-executor-skip-"));
    try {
      mkdirSync(join(dir, "node_modules/@quickservicets"), { recursive: true });
      symlinkSync(join(import.meta.dir, ".."), join(dir, "node_modules/@quickservicets/core"), "dir");
      writeFileSync(
        join(dir, "skip.test.ts"),
        'import { runSqlExecutorContract } from "@quickservicets/core/testing";\nrunSqlExecutorContract(() => { throw new Error("must not run"); }, { name: "neon", variable: "TEST_NEON_URL" });\n',
      );
      const child = Bun.spawnSync([process.execPath, "test", "--reporter=junit", "--reporter-outfile=report.xml"], { cwd: dir, env: { ...process.env, TEST_NEON_URL: "" }, stdout: "pipe", stderr: "pipe" });
      expect(child.exitCode).toBe(0);
      const report = readFileSync(join(dir, "report.xml"), "utf8");
      expect(report).toContain('name="neon executor contract: set TEST_NEON_URL to run it"');
      expect(report).toContain("<skipped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
