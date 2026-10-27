import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sqliteAdapter, type EntityModel } from "@quickservicets/core";
import { startTestApp } from "../../../core/src/tenancy-test-support.ts";
import { build } from "../build/build.ts";
import { run } from "../run.ts";
import { createLinkedProject } from "../testing/project.ts";
import { addMigration } from "./add.ts";

const ENTITIES = {
  "entities/Post.ts": "export type Post = { title: string };\n",
  "entities/Plan.ts": "/** @tenancy shared */\nexport type Plan = { name: string };\n",
};
const config = (root: string, keys: string) => `import { defineConfig, sqliteAdapter } from "@quickservicets/core";
export default defineConfig({ database: sqliteAdapter({ path: ${JSON.stringify(join(root, "data.db"))} }), ${keys}, logger: { info() {}, warn() {}, error() {} } });
`;

/** A SQLite project with tenancy (the database source by default), built and with its first migration written. */
async function project(keys = "tenancy: {}", entities: Record<string, string> = ENTITIES) {
  const root = createLinkedProject({ "quickservicets.config.ts": "", ...entities });
  writeFileSync(join(root, "quickservicets.config.ts"), config(root, keys));
  await build(root);
  const migration = await addMigration(root, "Initial", new Date(Date.UTC(2026, 9, 27, 12)));
  const cli = async (...args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(args, { log: (line) => out.push(line), error: (line) => err.push(line) }, root);
    return { code, out, err };
  };
  const query = <T>(text: string, file = "data.db") => {
    const db = new Database(join(root, file));
    try {
      return db.query(text).all() as T[];
    } finally {
      db.close();
    }
  };
  const tables = (file = "data.db") => query<{ name: string }>("select name from sqlite_master where type = 'table' order by name", file).map((row) => row.name);
  const insertTenant = (key: string, extra: Record<string, string> = {}) => {
    const db = new Database(join(root, "data.db"));
    const columns = { key, status: "active", ...extra };
    const names = Object.keys(columns);
    db.query(`insert into tenants (id, created_at, updated_at, ${names.join(", ")}) values (?, ?, ?, ${names.map(() => "?").join(", ")})`).run(
      Bun.randomUUIDv7(),
      Date.now(),
      Date.now(),
      ...Object.values(columns),
    );
    db.close();
  };
  return { root, cli, tables, query, insertTenant, migration: readFileSync(join(root, migration.file), "utf8"), id: migration.id };
}

describe("migration markers", () => {
  test("shared tables are marked { shared: true } and tenant tables are not; without tenancy nothing is marked", async () => {
    const { migration } = await project();
    expect(migration).toMatch(/ctx\.sql\("CREATE TABLE `\{\{default_schema\}\}plans`[^\n]*, \{ shared: true \}\);/);
    expect(migration).toMatch(/ctx\.sql\("CREATE TABLE `\{\{default_schema\}\}tenants`[^\n]*, \{ shared: true \}\);/);
    expect(migration).toMatch(/ctx\.sql\("CREATE TABLE `\{\{default_schema\}\}posts`[^\n]*"\);/);
    const plain = await project("events: {}", { ...ENTITIES, "entities/Plan.ts": "export type Plan = { name: string };\n" });
    expect(plain.migration).not.toContain("shared: true");
  });
});

describe("migrate", () => {
  test("the root run creates shared tables only; --tenant creates the tenant's tables in its schema, once", async () => {
    const { cli, tables, insertTenant, id } = await project();
    const root = await cli("migrate");
    expect(root.code).toBe(0);
    expect(root.out.at(-1)).toMatch(/^Skipped \d+ tenant statements; run quickservicets migrate --all-tenants$/);
    expect(tables()).toEqual(expect.arrayContaining(["plans", "tenants"]));
    expect(tables()).not.toContain("posts");
    insertTenant("acme");
    expect(await cli("migrate", "--tenant", "acme")).toEqual({ code: 0, out: [`acme: Applied ${id}`], err: [] });
    expect(tables()).toContain("tenant_acme__posts");
    expect(await cli("migrate", "--tenant", "acme")).toEqual({ code: 0, out: ["acme: Up to date"], err: [] });
    const unknown = await cli("migrate", "--tenant", "nope");
    expect([unknown.code, unknown.err.join(" ")]).toEqual([1, expect.stringContaining("Unknown tenant nope")]);
  });

  test("a database-strategy tenant is migrated into its own file", async () => {
    const { root, cli, tables, insertTenant } = await project();
    await cli("migrate");
    insertTenant("globex", { strategy: "database", connection: join(root, "globex.db") });
    expect((await cli("migrate", "--tenant", "globex")).code).toBe(0);
    expect(tables("globex.db")).toContain("posts");
    expect(tables("globex.db")).not.toContain("plans");
  });

  test("--all-tenants stops at a failure and exits 1; --continue-on-error migrates the others", async () => {
    const { root, cli, insertTenant } = await project();
    await cli("migrate");
    insertTenant("a");
    insertTenant("b");
    insertTenant("broken", { strategy: "database", connection: join(root, "missing-dir", "x.db") });
    const stopped = await cli("migrate", "--all-tenants", "--concurrency", "2");
    expect(stopped.code).toBe(1);
    expect(stopped.out.some((line) => line.startsWith("broken: Failed:"))).toBe(true);
    const all = await cli("migrate", "--all-tenants", "--continue-on-error");
    expect(all.code).toBe(1);
    expect(all.out.at(-1)).toBe("Migrated 2 tenants, 1 failed");
  });
});

describe("tenants commands", () => {
  test("create migrates and activates; a failing migration leaves the tenant suspended; suspend makes requests answer 403", async () => {
    const { root, cli, tables, query } = await project();
    await cli("migrate");
    expect(await cli("tenants", "create", "acme", "--plan", "pro")).toEqual({ code: 0, out: ["Created acme"], err: [] });
    expect(tables()).toContain("tenant_acme__posts");
    const failed = await cli("tenants", "create", "initech", "--strategy", "database", "--connection", join(root, "missing-dir", "x.db"));
    expect(failed.code).toBe(1);
    expect(failed.err[0]).toMatch(/^Created initech as suspended: .+; fix it and run quickservicets migrate --tenant initech, then quickservicets tenants resume initech$/);
    expect(failed.err[0]).not.toContain("missing-dir");
    expect(query<{ key: string; status: string; plan: string | null }>("select key, status, plan from tenants order by key")).toEqual([
      { key: "acme", status: "active", plan: "pro" },
      { key: "initech", status: "suspended", plan: null },
    ]);
    const listed = await cli("tenants", "list", "--pending");
    expect(listed.out).toEqual(["acme active schema tenant-acme pro pending=0", "initech suspended database database - pending=?"]);
    const { models } = (await import(join(root, ".generated/models.ts"))) as { models: EntityModel[] };
    const serve = async () => startTestApp({ database: sqliteAdapter({ path: join(root, "data.db") }), models, config: { tenancy: {} } });
    let app = await serve();
    expect((await app.fetch("/posts", { headers: { "x-tenant-id": "acme" } })).status).toBe(200);
    await app.stop();
    expect(await cli("tenants", "suspend", "acme")).toEqual({ code: 0, out: ["Suspended acme"], err: [] });
    app = await serve();
    expect((await app.fetch("/posts", { headers: { "x-tenant-id": "acme" } })).status).toBe(403);
    await app.stop();
    expect((await cli("tenants", "resume", "acme")).out).toEqual(["Resumed acme"]);
    expect(await cli("tenants", "suspend", "nope")).toEqual({ code: 1, out: [], err: ["Unknown tenant nope"] });
  });

  test("write commands need the database source; the CLI reference lists the commands and flags", async () => {
    const { cli } = await project('tenancy: { source: "config", tenants: { acme: {} } }');
    expect(await cli("tenants", "create", "acme")).toEqual({ code: 1, out: [], err: ['tenants create needs tenancy: { source: "database" }'] });
    expect(await cli("tenants", "suspend", "acme")).toEqual({ code: 1, out: [], err: ['tenants suspend needs tenancy: { source: "database" }'] });
    const docs = join(import.meta.dir, "../../../../docs/src/content/docs/reference");
    const cliPage = readFileSync(join(docs, "cli.mdx"), "utf8");
    for (const text of ["tenants list", "tenants create", "tenants suspend", "tenants resume", "--all-tenants", "--continue-on-error", "--tenant"]) expect(cliPage).toContain(text);
    expect(readFileSync(join(docs, "features/tenancy.mdx"), "utf8")).toContain("tenants create");
  });
});

describe("jobs for each tenant", () => {
  test("job run <name> --tenant <id> runs a tenants: each job for that tenant only", async () => {
    const { cli, insertTenant } = await project("tenancy: {}", {
      ...ENTITIES,
      "jobs/report.ts": 'import { job } from "@quickservicets/core";\nexport default job({ every: "1h" }, async (ctx) => ({ tenant: ctx.tenant?.id }), { tenants: "each" });\n',
    });
    await cli("migrate");
    insertTenant("acme");
    insertTenant("globex");
    await cli("migrate", "--all-tenants");
    const one = await cli("job", "run", "report", "--tenant", "acme");
    expect([one.code, one.out[1]]).toEqual([0, 'Result: {"tenants":1,"failed":[]}']);
    const all = await cli("job", "run", "report");
    expect([all.code, all.out[1]]).toEqual([0, 'Result: {"tenants":2,"failed":[]}']);
  });
});
