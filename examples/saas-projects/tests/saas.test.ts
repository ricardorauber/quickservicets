import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { SQL } from "bun";
import { currentDatabaseScope, loadConfig, runForTenant, type Repositories, type Repository } from "@quickservicets/core";
import { parseProjectEntities } from "@quickservicets/cli";
import { runTenantIsolationSuite } from "@quickservicets/core/testing";
import { startTestService, type TestService } from "@quickservicets/cli/testing";
import { seedShowcase } from "../lib/seed.ts";

const root = join(import.meta.dir, "..");
const cli = join(root, "../../packages/cli/src/index.ts");
const DOMAIN = "saas.test";
// The config reads APP_DOMAIN from process.env; QS_TENANCY_DOMAIN sets the same option for a test service.
const env = { QS_TENANCY_DOMAIN: DOMAIN, TENANT_DATABASE_TEMPLATE: "saas_{tenant}" };

/** The showcase's own files, as `startTestService` takes them. */
function showcaseFiles(): Record<string, string> {
  const files: Record<string, string> = { "quickservicets.config.ts": readFileSync(join(root, "quickservicets.config.ts"), "utf8") };
  for (const folder of ["entities", "endpoints", "hooks", "queues", "lib"]) {
    for (const entry of readdirSync(join(root, folder), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files[relative(root, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), "utf8");
    }
  }
  return files;
}

const json = { "content-type": "application/json" };
const as = (tenant: string, init: RequestInit = {}) => ({ ...init, headers: { "x-tenant-id": tenant, ...json, ...((init.headers as Record<string, string>) ?? {}) } });
const post = (body: unknown) => ({ method: "POST", headers: json, body: JSON.stringify(body) });
const listOf = async (response: Response) => ((await response.json()) as { data: Record<string, unknown>[] }).data;
const repo = (repos: Repositories, key: string) => (repos as unknown as Record<string, Repository>)[key]!;

let service: TestService;
beforeAll(async () => {
  service = await startTestService({ files: showcaseFiles(), env });
  await seedShowcase(service.repos);
});
afterAll(() => service.stop());

describe("sign-up and provisioning", () => {
  test("POST /signup provisions the workspace and makes its owner a member; a second one answers 409", async () => {
    const created = await service.fetch("/signup", post({ workspace: "hooli", plan: "free", owner: "gavin" }));
    expect([created.status, await created.json()]).toEqual([201, { id: "hooli" }]);
    expect(await listOf(await service.fetch("/projects", as("hooli")))).toEqual([]);
    const members = await repo(service.repos, "members").list({ where: [{ field: "tenantKey", op: "eq", value: "hooli" }], sort: [], limit: 10, offset: 0 });
    expect(members.data.map((member) => [member.userId, member.role])).toEqual([["gavin", "owner"]]);
    const again = await service.fetch("/signup", post({ workspace: "hooli", plan: "free" }));
    expect([again.status, ((await again.json()) as { error: { message: string } }).error.message]).toEqual([409, "Workspace already exists"]);
    expect((await service.fetch("/signup", post({ workspace: "../x", plan: "free" }))).status).toBe(400);
    expect((await service.fetch("/signup", post({ workspace: "piedpiper", plan: "platinum" }))).status).toBe(400);
  });
});

describe("plan limits", () => {
  test("a fourth project in acme answers 402 while globex creates it", async () => {
    const create = (tenant: string, name: string) => service.fetch("/projects", as(tenant, { method: "POST", body: JSON.stringify({ name }) }));
    // acme (free) has the 2 seeded projects; a third fits.
    expect((await create("acme", "Third")).status).toBe(201);
    const fourth = await create("acme", "Fourth");
    const body = (await fourth.json()) as { error: { code: string; message: string } };
    expect([fourth.status, body.error.code, body.error.message]).toEqual([402, "PLAN_LIMIT_REACHED", "Your plan allows 3 projects"]);
    for (const name of ["Third", "Fourth"]) expect((await create("globex", name)).status).toBe(201);
  });
});

describe("strategy placement and isolation", () => {
  test("acme lives in a schema of the service's database, initech in a database of its own", async () => {
    const rootAdapter = currentDatabaseScope().adapter;
    const acme = await runForTenant("acme", () => currentDatabaseScope().adapter);
    const initech = await runForTenant("initech", () => currentDatabaseScope().adapter);
    expect(acme.sharesConnectionWith?.(rootAdapter)).toBe(true);
    expect(initech.sharesConnectionWith?.(rootAdapter) ?? false).toBe(false);
    const names = (tenant: string) => runForTenant(tenant, async ({ repos }) => (await repo(repos as never, "projects").list({ where: [], sort: [], limit: 50, offset: 0 })).data.map((project) => project.name));
    expect(await names("initech")).toEqual(["TPS reports"]);
    expect(await names("acme")).not.toContain("TPS reports");
  });

  test("the subdomain and the header reach the same workspace", async () => {
    const bySubdomain = await listOf(await service.fetch(`http://globex.${DOMAIN}/projects`));
    const byHeader = await listOf(await service.fetch("/projects", as("globex")));
    expect(bySubdomain.map((project) => project.id).sort()).toEqual(byHeader.map((project) => project.id).sort());
    expect(bySubdomain.length).toBeGreaterThan(0);
  });
});

describe("background work of the enterprise tenant", () => {
  test("a reminder queued in initech is relayed and processed in initech's database", async () => {
    const [project] = await listOf(await service.fetch("/projects", as("initech")));
    const task = (await (await service.fetch("/tasks", as("initech", { method: "POST", body: JSON.stringify({ project: project!.id, title: "Cover sheets" }) }))).json()) as { id: string };
    expect((await service.fetch(`/tasks/${task.id}/remind`, as("initech", { method: "POST" }))).status).toBe(200);
    const comments = () => runForTenant("initech", async ({ repos }) => (await repo(repos as never, "comments").list({ where: [], sort: [], limit: 50, offset: 0 })).data.map((comment) => comment.body));
    for (let tries = 0; tries < 300 && !(await comments()).includes("Reminder sent: Cover sheets"); tries++) await Bun.sleep(10);
    expect(await comments()).toContain("Reminder sent: Cover sheets");
  });
});

// The isolation suite against the showcase's tenant entities, on memory always and on the real servers when configured.
process.env.TENANT_DATABASE_TEMPLATE ??= env.TENANT_DATABASE_TEMPLATE;
const config = await loadConfig(root);
const models = parseProjectEntities(root, config.features);
for (const strategy of ["schema", "database"] as const) {
  runTenantIsolationSuite({ adapter: "memory", strategy, name: "saas-projects", models, entities: ["Project"] });
  runTenantIsolationSuite({ adapter: "postgres", strategy, name: "saas-projects", models, entities: ["Project"], prefix: "qs_b11_saas_iso", ...(process.env.TEST_POSTGRES_URL ? { url: process.env.TEST_POSTGRES_URL } : {}) });
  runTenantIsolationSuite({ adapter: "mongodb", strategy, name: "saas-projects", models, entities: ["Project"], prefix: "qs_b11_saas_iso", ...(process.env.TEST_MONGODB_URL ? { url: process.env.TEST_MONGODB_URL } : {}) });
}

const pgUrl = process.env.TEST_POSTGRES_URL;
describe("on PostgreSQL", () => {
  test.skipIf(!pgUrl)("migrate --all-tenants and the seed put acme and globex in schemas of the service's database and initech in its own database", async () => {
    const server = new URL(pgUrl!);
    // Built as text, so {tenant} stays a placeholder instead of being percent-encoded.
    const at = (database: string) => `${server.protocol}//${server.username ? `${server.username}${server.password ? `:${server.password}` : ""}@` : ""}${server.host}/${database}${server.search}`;
    const rootDb = "qs_b11_saas";
    const admin = new SQL(pgUrl!);
    for (const database of [rootDb, `${rootDb}_initech`]) {
      // quickservicets-allow-unsafe: database names cannot be parameters; these are the test's own fixed names.
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      // quickservicets-allow-unsafe: database names cannot be parameters; these are the test's own fixed names.
      await admin.unsafe(`create database ${database}`);
    }
    const dir = mkdtempSync(join(root, ".e2e-"));
    try {
      for (const entry of ["quickservicets.config.ts", "entities", "endpoints", "hooks", "queues", "lib", "scripts", "migrations"]) cpSync(join(root, entry), join(dir, entry), { recursive: true });
      const probe = Bun.serve({ port: 0, fetch: () => new Response() });
      const seedPort = String(probe.port);
      probe.stop(true);
      const runEnv = { ...process.env, DATABASE_URL: at(rootDb), TENANT_DATABASE_TEMPLATE: at(`${rootDb}_{tenant}`), APP_DOMAIN: DOMAIN, SEED_PORT: seedPort };
      const run = (...command: string[]) => {
        const result = Bun.spawnSync(command, { cwd: dir, env: runEnv, stdout: "pipe", stderr: "pipe" });
        if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${result.stderr.toString()}${result.stdout.toString()}`);
        return result.stdout.toString();
      };
      run("bun", cli, "build");
      run("bun", cli, "migrate", "--all-tenants", "--yes");
      run("bun", "scripts/seed.ts");
      const migrated = run("bun", cli, "migrate", "--all-tenants", "--yes");
      for (const tenant of ["acme", "globex", "initech"]) expect(migrated).toContain(`${tenant}: Up to date`);
      const rootSql = new SQL(at(rootDb));
      const initechSql = new SQL(at(`${rootDb}_initech`));
      try {
        const schemas = (await rootSql`select table_schema, count(*)::int as tables from information_schema.tables where table_name = 'projects' group by table_schema order by table_schema`) as { table_schema: string }[];
        expect(schemas.map((row) => row.table_schema)).toEqual(["tenant_acme", "tenant_globex"]);
        const plans = (await rootSql`select slug from plans order by slug`) as { slug: string }[];
        expect(plans.map((row) => row.slug)).toEqual(["enterprise", "free", "pro"]);
        const projects = (await initechSql`select name from projects`) as { name: string }[];
        expect(projects.map((row) => row.name)).toEqual(["TPS reports"]);
      } finally {
        await rootSql.close();
        await initechSql.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      for (const database of [rootDb, `${rootDb}_initech`]) {
        // quickservicets-allow-unsafe: database names cannot be parameters; these are the test's own fixed names.
        await admin.unsafe(`drop database if exists ${database} with (force)`);
      }
      await admin.close();
    }
  }, 120_000);
});
