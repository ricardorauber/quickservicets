import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { addMigration } from "../migrations/add.ts";
import { migrate } from "../migrations/migrate.ts";
import { run } from "../run.ts";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";
import { build } from "./build.ts";

const config = (flags: string, adapter = "memoryAdapter()") => `import { defineConfig, memoryAdapter, sqliteAdapter, postgresAdapter } from "@quickservicets/core";
export default defineConfig({ database: ${adapter}, flags: ${flags}, logger: { info() {}, warn() {}, error() {} } });
`;
const DATABASE = '{ source: "database", rules: { "checkout-v2": true, "dark-mode": true } }';
const FILES = {
  "quickservicets.config.ts": config(DATABASE),
  "endpoints/settings/get.ts": 'import type { Repositories, ServiceRequest } from "@quickservicets/core";\nexport default (_repos: Repositories, req: ServiceRequest) => req.flags!.all();\n',
  "endpoints/toggle/post.ts": `import type { Repositories } from "@quickservicets/core";
export default async (repos: Repositories) => {
  const existing = await repos.featureFlags.where((flag) => flag.name.eq("checkout-v2")).firstOrDefault();
  if (existing) await repos.featureFlags.update(existing.id, { enabled: !existing.enabled });
  else await repos.featureFlags.create({ name: "checkout-v2", enabled: false });
  return { ok: true };
};
`,
};

describe("the FeatureFlag table", () => {
  for (const [name, adapter] of Object.entries({ sqlite: 'sqliteAdapter({ path: ":memory:" })', postgres: 'postgresAdapter({ url: "postgres://localhost/none" })' })) {
    test(`${name}: migration add creates feature_flags`, async () => {
      const root = createLinkedProject({ ...FILES, "quickservicets.config.ts": config(DATABASE, adapter) });
      const created = readFileSync(join(root, (await addMigration(root, "Flags", new Date(Date.UTC(2026, 0, 1)))).file), "utf8");
      expect(created).toMatch(/CREATE TABLE \\?[`"](\{\{default_schema\}\})?feature_flags/);
    });
  }

  test("it has no routes, its repository is writable and typed, and an endpoint's write changes the next request's flags", async () => {
    const root = createLinkedProject(FILES);
    await build(root);
    const check = join(root, "check.ts");
    writeFileSync(check, 'import type { Repositories } from "@quickservicets/core";\nexport const add = (repos: Repositories) => repos.featureFlags.create({ name: "beta", users: ["u1"] });\n');
    const program = ts.createProgram([check, join(root, ".generated/types.ts")], { strict: true, noEmit: true, skipLibCheck: true, lib: ["lib.esnext.d.ts", "lib.dom.d.ts"], types: [], target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true });
    expect(ts.getPreEmitDiagnostics(program, program.getSourceFile(check)).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))).toEqual([]);
    const service = await startTestService({ files: FILES });
    try {
      const listed = await service.fetch("/feature-flags");
      expect([listed.status, ((await listed.json()) as { error: { message: string } }).error.message]).toEqual([404, "Route not found"]);
      expect(((await (await service.fetch("/settings")).json()) as Record<string, boolean>)["checkout-v2"]).toBe(true);
      await service.fetch("/toggle", { method: "POST" });
      expect(((await (await service.fetch("/settings")).json()) as Record<string, boolean>)["checkout-v2"]).toBe(false);
    } finally {
      await service.stop();
    }
  });
});

describe("commands", () => {
  async function sqliteProject(flags: string) {
    const root = createLinkedProject({ "quickservicets.config.ts": "" });
    writeFileSync(join(root, "quickservicets.config.ts"), config(flags, `sqliteAdapter({ path: ${JSON.stringify(join(root, "data.db"))} })`));
    await build(root);
    if (flags.includes("database")) {
      await addMigration(root, "Flags", new Date(Date.UTC(2026, 9, 15, 12)));
      await migrate(root);
    }
    return async (...args: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await run(args, { log: (line) => out.push(line), error: (line) => err.push(line) }, root);
      return { code, out, err };
    };
  }

  test("flags set creates and updates rows changing only what is given; flags list shows origins; flags remove deletes", async () => {
    const cli = await sqliteProject(DATABASE);
    expect(await cli("flags", "set", "beta", "--percentage", "10", "--users", "u1,u2")).toEqual({ code: 0, out: ["beta database on users=2 tenants=0 percentage=10"], err: [] });
    expect(await cli("flags", "set", "beta", "--off")).toEqual({ code: 0, out: ["beta database off users=2 tenants=0 percentage=10"], err: [] });
    await cli("flags", "set", "checkout-v2", "--off");
    expect((await cli("flags", "list")).out).toEqual([
      "beta database off users=2 tenants=0 percentage=10",
      "checkout-v2 both off users=0 tenants=0 percentage=-",
      "dark-mode config on users=0 tenants=0 percentage=-",
    ]);
    expect(await cli("flags", "remove", "checkout-v2")).toEqual({ code: 0, out: ["Removed checkout-v2; the config rule applies again"], err: [] });
    expect(await cli("flags", "remove", "beta")).toEqual({ code: 0, out: ["Removed beta"], err: [] });
    expect((await cli("flags", "set", "Bad Name", "--on")).err).toEqual(['Invalid flags.rules.Bad Name: a flag name starts with a lowercase letter and uses lowercase letters, digits, "_" and "-"']);
  });

  test("with the config source, set and remove fail and list works without a database", async () => {
    const cli = await sqliteProject('{ rules: { "dark-mode": true } }');
    expect(await cli("flags", "set", "beta", "--on")).toEqual({ code: 1, out: [], err: ['flags set needs flags: { source: "database" }'] });
    expect(await cli("flags", "remove", "beta")).toEqual({ code: 1, out: [], err: ['flags remove needs flags: { source: "database" }'] });
    expect((await cli("flags", "list")).out).toEqual(["dark-mode config on users=0 tenants=0 percentage=-"]);
  });

  test("the CLI reference and the native's page list the commands", () => {
    const docs = join(import.meta.dir, "../../../../docs/src/content/docs/reference");
    for (const page of ["cli.mdx", "features/flags.mdx"]) {
      const text = readFileSync(join(docs, page), "utf8");
      for (const command of ["flags list", "flags set", "flags remove"]) expect(text).toContain(command);
    }
  });
});
