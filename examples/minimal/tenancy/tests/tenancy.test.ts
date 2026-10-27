import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { currentDatabaseScope, loadConfig, runForTenant, type Repositories, type Repository } from "@quickservicets/core";
import { parseProjectEntities } from "@quickservicets/cli";
import { runTenantIsolationSuite } from "@quickservicets/core/testing";
import { startTestService } from "@quickservicets/cli/testing";

const root = join(import.meta.dir, "..");
const cli = join(root, "../../../packages/cli/src/index.ts");

/** The example's own files, as `startTestService` takes them. */
function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = { "quickservicets.config.ts": readFileSync(join(root, "quickservicets.config.ts"), "utf8") };
  for (const folder of ["entities", "endpoints", "queues", "jobs"]) {
    for (const entry of readdirSync(join(root, folder), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files[relative(root, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), "utf8");
    }
  }
  return files;
}

const as = (tenant: string, init: RequestInit = {}) => ({ ...init, headers: { "x-tenant-id": tenant, "content-type": "application/json", ...((init.headers as Record<string, string>) ?? {}) } });
const names = (repos: Repositories, key: string, field: string) =>
  (repos as unknown as Record<string, Repository>)[key]!.list({ where: [], sort: [], limit: 100, offset: 0 }).then((page) => page.data.map((record) => record[field]));

test("tenants are isolated: globex in its own database, acme in a schema; plans, the consumer and the job", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    const tenants = (service.repos as unknown as Record<string, Repository>).tenants!;
    await tenants.create({ key: "acme", plan: "free" });
    await tenants.create({ key: "globex", plan: "enterprise" });
    await (service.repos as unknown as Record<string, Repository>).plans!.create({ name: "free", price: 0 });

    const created = await service.fetch("/projects", as("acme", { method: "POST", body: JSON.stringify({ name: "Rocket" }) }));
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect((await service.fetch("/projects", as("globex", { method: "POST", body: JSON.stringify({ name: "Anvil" }) }))).status).toBe(201);
    expect(((await (await service.fetch("/projects", as("acme"))).json()) as { data: { name: string }[] }).data.map((project) => project.name)).toEqual(["Rocket"]);
    expect((await service.fetch(`/projects/${id}`, as("globex"))).status).toBe(404);

    // globex's data lives in a store of its own; acme's in a schema view of the service's database.
    const rootAdapter = currentDatabaseScope().adapter;
    const acme = await runForTenant("acme", () => currentDatabaseScope().adapter);
    const globex = await runForTenant("globex", () => currentDatabaseScope().adapter);
    expect(acme.sharesConnectionWith?.(rootAdapter)).toBe(true);
    expect(globex.sharesConnectionWith?.(rootAdapter) ?? false).toBe(false);
    expect(globex).not.toBe(rootAdapter);

    expect(((await (await service.fetch("/plans")).json()) as { data: { name: string }[] }).data.map((plan) => plan.name)).toEqual(["free"]);
    const missing = await service.fetch("/projects");
    expect([missing.status, ((await missing.json()) as { error: { code: string } }).error.code]).toEqual([400, "TENANT_REQUIRED"]);

    expect((await service.fetch(`/projects/${id}/notify`, as("acme", { method: "POST" }))).status).toBe(200);
    for (let tries = 0; tries < 200 && (await runForTenant("acme", ({ repos }) => names(repos as never, "notifications", "message"))).length === 0; tries++) await Bun.sleep(10);
    expect(await runForTenant("acme", ({ repos }) => names(repos as never, "notifications", "message"))).toEqual(["acme: Rocket changed"]);
    expect(await runForTenant("globex", ({ repos }) => names(repos as never, "notifications", "message"))).toEqual([]);

    expect((await service.fetch("/digests/run", { method: "POST" })).status).toBe(200);
    for (let tries = 0; tries < 200 && (await runForTenant("globex", ({ repos }) => names(repos as never, "digests", "projects"))).length === 0; tries++) await Bun.sleep(10);
    expect(await runForTenant("acme", ({ repos }) => names(repos as never, "digests", "projects"))).toEqual([1]);
    expect(await runForTenant("globex", ({ repos }) => names(repos as never, "digests", "projects"))).toEqual([1]);
  } finally {
    await service.stop();
  }
});

describe("the example's SQLite configuration", () => {
  test("migrate and the seed create acme's schema in data.db and globex's own file, and the service serves both", async () => {
    // A copy inside the example, so it resolves the workspace packages.
    const dir = mkdtempSync(join(root, ".e2e-"));
    try {
      for (const entry of ["quickservicets.config.ts", "entities", "endpoints", "queues", "jobs", "migrations", "scripts"]) cpSync(join(root, entry), join(dir, entry), { recursive: true });
      const run = (...args: string[]) => {
        const result = Bun.spawnSync(["bun", cli, ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
        if (result.exitCode !== 0) throw new Error(`quickservicets ${args.join(" ")} failed: ${result.stderr.toString()}`);
        return result.stdout.toString();
      };
      run("build");
      run("migrate");
      // What scripts/seed.ts does, through this repository's CLI.
      Bun.spawnSync(["mkdir", "-p", "data"], { cwd: dir });
      expect(run("tenants", "create", "acme", "--plan", "free")).toContain("Created acme");
      expect(run("tenants", "create", "globex", "--plan", "enterprise")).toContain("Created globex");
      // A free port, found by listening on port 0 for a moment.
      const probe = Bun.serve({ port: 0, fetch: () => new Response() });
      const free = String(probe.port);
      probe.stop(true);
      const server = Bun.spawn(["bun", ".generated/server.ts"], { cwd: dir, env: { ...process.env, PORT: free }, stdout: "pipe", stderr: "pipe" });
      try {
        const reader = server.stdout.getReader();
        let output = "";
        while (!/listening on http:\/\/localhost:(\d+)/.test(output)) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error(`the service stopped: ${output}`);
          output += new TextDecoder().decode(chunk.value);
        }
        const port = /listening on http:\/\/localhost:(\d+)/.exec(output)![1];
        const call = (path: string, init: RequestInit) => fetch(`http://localhost:${port}${path}`, init);
        expect((await call("/projects", as("acme", { method: "POST", body: JSON.stringify({ name: "Rocket" }) }))).status).toBe(201);
        expect((await call("/projects", as("globex", { method: "POST", body: JSON.stringify({ name: "Anvil" }) }))).status).toBe(201);
      } finally {
        server.kill();
        await server.exited;
      }
      const rows = (file: string, query: string) => {
        const db = new Database(join(dir, file));
        try {
          return db.query(query).all();
        } finally {
          db.close();
        }
      };
      expect(rows("data.db", "select name from tenant_acme__projects")).toEqual([{ name: "Rocket" }]);
      expect(rows("data/tenant_globex.db", "select name from projects")).toEqual([{ name: "Anvil" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

// The isolation suite runs on the example's own entities too.
const config = await loadConfig(root);
runTenantIsolationSuite({ adapter: "memory", strategy: "schema", name: "example", models: parseProjectEntities(root, config.features), entities: ["Project"] });
