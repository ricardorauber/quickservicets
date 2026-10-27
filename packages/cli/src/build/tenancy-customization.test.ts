import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sqliteAdapter, type EntityModel } from "@quickservicets/core";
import { startTestApp } from "../../../core/src/tenancy-test-support.ts";
import { addMigration } from "../migrations/add.ts";
import { migrate } from "../migrations/migrate.ts";
import { run } from "../run.ts";
import { createLinkedProject } from "../testing/project.ts";
import { build } from "./build.ts";

const config = (root: string, keys = "tenancy: {}") => `import { defineConfig, sqliteAdapter } from "@quickservicets/core";
export default defineConfig({ database: sqliteAdapter({ path: ${JSON.stringify(join(root, "data.db"))} }), ${keys}, logger: { info() {}, warn() {}, error() {} } });
`;

async function project(files: Record<string, string>, keys?: string) {
  const root = createLinkedProject({ "quickservicets.config.ts": "", "entities/Post.ts": "export type Post = { title: string };\n", ...files });
  writeFileSync(join(root, "quickservicets.config.ts"), config(root, keys));
  const cli = async (...args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(args, { log: (line) => out.push(line), error: (line) => err.push(line) }, root);
    return { code, out, err };
  };
  return { root, cli };
}

describe("level 0", () => {
  test("tenancy: {} and tenants create acme serve GET /posts for acme", async () => {
    const { root, cli } = await project({});
    await build(root);
    await addMigration(root, "Initial", new Date(Date.UTC(2026, 9, 27, 12)));
    await migrate(root);
    expect(await cli("tenants", "create", "acme")).toEqual({ code: 0, out: ["Created acme"], err: [] });
    const { models } = (await import(join(root, ".generated/models.ts"))) as { models: EntityModel[] };
    const app = await startTestApp({ database: sqliteAdapter({ path: join(root, "data.db") }), models, config: { tenancy: {} } });
    try {
      expect((await app.fetch("/posts", { headers: { "x-tenant-id": "acme" } })).status).toBe(200);
    } finally {
      await app.stop();
    }
  });
});

describe("override files", () => {
  test("a project Tenant with an extra field builds and migrates; one without status fails naming the field", async () => {
    const extra = await project({ "entities/Tenant.ts": 'export type Tenant = { key: string; plan?: string; strategy?: "schema" | "database"; schema?: string; connection?: string; status: "active" | "suspended"; attributes?: { region?: string }; billingEmail?: string };\n' });
    await build(extra.root);
    const created = readFileSync(join(extra.root, (await addMigration(extra.root, "Initial", new Date(Date.UTC(2026, 9, 27, 12)))).file), "utf8");
    expect(created).toContain("billing_email");
    expect((await migrate(extra.root)).applied).toHaveLength(1);
    const missing = await project({ "entities/Tenant.ts": 'export type Tenant = { key: string; plan?: string; strategy?: "schema" | "database"; schema?: string; connection?: string; attributes?: { region?: string } };\n' });
    const failure = await build(missing.root).then(() => "built", (error: Error) => error.message);
    expect(failure).toContain("entities/Tenant.ts: Tenant needs the field status (enum) used by tenancy");
  });

  test("a project jobs/tenancy/relay.ts replaces the native's relay job", async () => {
    const { root } = await project({ "jobs/tenancy/relay.ts": 'import { job } from "@quickservicets/core";\nexport default job("@hourly", async () => {});\n' });
    const summary = await build(root);
    expect(summary.overrides).toEqual([expect.stringMatching(/^Override: jobs\/tenancy\/relay\.ts replaces .*tenancy\/jobs\/relay\.ts from tenancy$/)]);
  });
});

describe("the reference", () => {
  test("the tenancy page lists the strategy variable, the tag, the hooks and the tenants commands", () => {
    const page = readFileSync(join(import.meta.dir, "../../../../docs/src/content/docs/reference/features/tenancy.mdx"), "utf8");
    for (const text of ["QS_TENANCY_STRATEGY", "@tenancy", "beforeResolve", "afterResolve", "onUnknownTenant", "onPoolOpen", "tenancy.directory", "tenancy.resolver", "tenants create", "tenants list", "setDirectory", "addHook", "TENANT_REQUIRED"]) {
      expect(page.includes(text) ? text : `missing ${text}`).toBe(text);
    }
  });
});
