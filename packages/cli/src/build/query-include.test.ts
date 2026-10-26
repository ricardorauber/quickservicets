import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRepositories, HttpError, memoryAdapter, type Repository } from "@quickservicets/core";
import ts from "typescript";
import { parseProjectEntities } from "../entities/parse-entities.ts";
import { createLinkedProject } from "../testing/project.ts";
import { build } from "./build.ts";

const entities = {
  "entities/Module.ts": "export enum ModuleAction { manage, view }\nexport type Module = { slug: string; active: boolean }",
  "entities/Permission.ts": 'import { Module, ModuleAction } from "./Module";\nexport type Permission = { module: Module; action: ModuleAction }',
  "entities/Profile.ts": 'import { Permission } from "./Permission";\nexport type Profile = { slug: string; permissions: Permission[] }',
  "entities/Membership.ts": 'import { Profile } from "./Profile";\nexport type Membership = { user: string; profiles: Profile[]; active: boolean }',
};

const config = (maxDepth?: number) =>
  `import { defineConfig, memoryAdapter } from "@quickservicets/core";\nexport default defineConfig({ database: memoryAdapter()${maxDepth ? `, populate: { maxDepth: ${maxDepth} }` : ""} });\n`;

async function setup(maxDepth?: number) {
  const root = createLinkedProject({ "quickservicets.config.ts": config(maxDepth), ...entities });
  const models = parseProjectEntities(root);
  const adapter = memoryAdapter();
  await adapter.connect(models);
  const repos = createRepositories(models, adapter, { populateMaxDepth: maxDepth }) as unknown as Record<string, Repository<any, any>>;
  const billing = await repos.modules!.create({ slug: "billing", active: true });
  const manage = await repos.permissions!.create({ module: billing.id, action: "manage" });
  const finance = await repos.profiles!.create({ slug: "finance", permissions: [manage.id] });
  const membership = await repos.memberships!.create({ user: "ana", profiles: [finance.id], active: true });
  return { root, repos, billing, manage, finance, membership };
}

describe("include", () => {
  test("one, two and three segments", async () => {
    const { repos, finance, manage } = await setup(3);
    const [one] = await repos.memberships!.where((m: any) => m.user.eq("ana")).include("profiles").all();
    expect(one!.profiles[0].slug).toBe("finance");
    expect(one!.profiles[0].permissions).toEqual([manage.id]);
    const [two] = await repos.memberships!.query().include("profiles.permissions").all();
    expect(two!.profiles[0].permissions[0].action).toBe("manage");
    const [three] = await repos.memberships!.query().include("profiles.permissions.module").all();
    expect(three!.profiles[0].permissions[0].module.slug).toBe("billing");
    expect(three!.profiles[0].id).toBe(finance.id);
  });

  test("paths past populate.maxDepth fail with the populate error", async () => {
    const { repos } = await setup();
    try {
      await repos.memberships!.query().include("profiles.permissions.module").all();
      throw new Error("expected an error");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).message).toBe("Populate depth exceeds 2");
    }
  });
});

describe("findByIds", () => {
  test("keeps the order, skips missing ids and repeats none", async () => {
    const { repos } = await setup(3);
    const a = await repos.modules!.create({ slug: "a", active: true });
    const c = await repos.modules!.create({ slug: "c", active: true });
    const found = await repos.modules!.findByIds([c.id, a.id, "01a10000-0000-7000-8000-000000000000", a.id]);
    expect(found.map((module: { slug: string }) => module.slug)).toEqual(["c", "a"]);
  });

  test("loads more ids than one batch, and includes paths", async () => {
    const { repos, finance } = await setup(3);
    const ids: string[] = [];
    for (let index = 0; index < 250; index++) ids.push((await repos.modules!.create({ slug: `m${index}`, active: true })).id);
    expect((await repos.modules!.findByIds(ids)).map((module: { id: string }) => module.id)).toEqual(ids);
    const [profile] = await repos.profiles!.findByIds([finance.id], { include: ["permissions.module"] });
    expect(profile!.permissions[0].module.slug).toBe("billing");
  });
});

test("deep includes and populate are typed at every level", async () => {
  const { root } = await setup(3);
  await build(root);
  const check = join(root, "check.ts");
  writeFileSync(
    check,
    `import type { GeneratedRepositories } from "./.generated/types.ts";
declare const repos: GeneratedRepositories;
export async function run() {
  const memberships = await repos.memberships.where((m) => m.active.eq(true)).include("profiles.permissions.module").all();
  const slug: string = memberships[0]!.profiles[0]!.permissions[0]!.module!.slug;
  const action: "manage" | "view" = memberships[0]!.profiles[0]!.permissions[0]!.action;
  const profiles = await repos.profiles.findByIds(["x"], { include: ["permissions.module"] });
  const active: boolean = profiles[0]!.permissions[0]!.module!.active;
  const permission = await repos.permissions.findById("x", { populate: ["module"] });
  const moduleSlug: string | undefined = permission?.module?.slug;
  const plain = await repos.permissions.findById("x");
  const id: string | undefined = plain?.module;
  // @ts-expect-error unknown path
  await repos.memberships.query().include("profiles.permisions");
  // @ts-expect-error unknown path on populate
  await repos.permissions.findById("x", { populate: ["modul"] });
  return [slug, action, active, moduleSlug, id];
}
`,
  );
  const program = ts.createProgram([check], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    lib: ["lib.esnext.d.ts"],
    types: [],
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program, program.getSourceFile(check));
  expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))).toEqual([]);
});
