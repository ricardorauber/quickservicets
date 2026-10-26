import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { build, GENERATED_INCLUDE_WARNING } from "../build/build.ts";
import { createLinkedProject, createProject, MEMORY_CONFIG } from "../testing/project.ts";
import { version } from "../version.ts";
import { initProject, NEXT_STEPS, quickservicetsWorkspace } from "./init.ts";

const pkg = (name: string) => JSON.stringify({ name, version: "0.1.0" });
const monorepo = (extra: Record<string, string> = {}) =>
  createProject({
    "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["packages/*", "examples/*"] }),
    "packages/core/package.json": pkg("@quickservicets/core"),
    "packages/cli/package.json": pkg("@quickservicets/cli"),
    ...extra,
  });
const dependencies = (root: string) => JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies;

test("the tsconfig includes the generated files", async () => {
  const root = join(createProject({}), "api");
  await initProject(root, { db: "memory" });
  const { config } = ts.readConfigFile(join(root, "tsconfig.json"), (path) => readFileSync(path, "utf8"));
  expect(config.include).toContain(".generated/**/*.ts");
  expect(config.include).not.toContain(".generated");
});

describe("workspace detection", () => {
  test("a folder matched by the monorepo's workspaces", () => {
    const repo = monorepo();
    expect(quickservicetsWorkspace(join(repo, "examples", "app"))).toBe(repo);
  });

  test("a workspace without the framework packages, or a folder outside the globs", () => {
    const other = createProject({
      "package.json": JSON.stringify({ name: "other", workspaces: ["apps/*"] }),
      "apps/web/package.json": pkg("web"),
    });
    expect(quickservicetsWorkspace(join(other, "apps", "api"))).toBeUndefined();
    expect(quickservicetsWorkspace(join(monorepo(), "tools", "app"))).toBeUndefined();
  });

  test("no workspace at all", () => {
    expect(quickservicetsWorkspace(join(createProject({}), "app"))).toBeUndefined();
  });
});

describe("dependencies and install", () => {
  test("inside the monorepo: workspace dependencies and an install at the root", async () => {
    const repo = monorepo();
    const installs: string[] = [];
    const steps = await initProject(join(repo, "examples", "app"), {
      db: "memory",
      install: async (root) => {
        installs.push(root);
        return true;
      },
    });
    expect(dependencies(join(repo, "examples", "app"))).toEqual({ "@quickservicets/core": "workspace:*", "@quickservicets/cli": "workspace:*" });
    expect(installs).toEqual([repo]);
    expect(steps.join("\n")).not.toContain("bun install");
    expect(steps[1]).toStartWith("  1. Create an entity");
  });

  test("outside: versioned dependencies and no install", async () => {
    let installed = false;
    const root = join(createProject({}), "app");
    const steps = await initProject(root, { db: "memory", install: async () => (installed = true) });
    expect(dependencies(root)).toEqual({ "@quickservicets/core": `^${version}`, "@quickservicets/cli": `^${version}` });
    expect(installed).toBe(false);
    expect(steps).toEqual(NEXT_STEPS);
  });

  test("a failed install is reported and the project stays", async () => {
    const repo = monorepo();
    const target = join(repo, "examples", "app");
    const steps = await initProject(target, { db: "memory", install: async () => false });
    expect(steps[0]).toBe(`Could not install dependencies; run "bun install" in ${repo}`);
    expect(existsSync(join(target, "quickservicets.config.ts"))).toBe(true);
  });
});

describe("build warning", () => {
  const tsconfig = (include: string[]) => JSON.stringify({ compilerOptions: { strict: true }, include });

  test("the old entry is reported and left as it is", async () => {
    const content = tsconfig(["entities", ".generated"]);
    const root = createLinkedProject({ "quickservicets.config.ts": MEMORY_CONFIG, "tsconfig.json": content });
    expect((await build(root)).warnings).toContain(GENERATED_INCLUDE_WARNING);
    expect(readFileSync(join(root, "tsconfig.json"), "utf8")).toBe(content);
  });

  test("the new entry, or no tsconfig, gives no warning", async () => {
    const fixed = createLinkedProject({ "quickservicets.config.ts": MEMORY_CONFIG, "tsconfig.json": tsconfig([".generated/**/*.ts"]) });
    expect((await build(fixed)).warnings).not.toContain(GENERATED_INCLUDE_WARNING);
    const none = createLinkedProject({ "quickservicets.config.ts": MEMORY_CONFIG });
    expect((await build(none)).warnings).not.toContain(GENERATED_INCLUDE_WARNING);
  });
});

test("generated repository types reach endpoints", async () => {
  const root = createLinkedProject({ "quickservicets.config.ts": MEMORY_CONFIG });
  await initProjectFiles(root);
  writeFileSync(join(root, "entities/User.ts"), "export type User = { email: string }");
  writeFileSync(
    join(root, "endpoints/stats/get.ts"),
    'import type { Endpoint } from "@quickservicets/core";\nconst handler: Endpoint = async (repos) => repos.users.findById("x");\nexport default handler;\n',
  );
  await build(root);
  const parsed = ts.getParsedCommandLineOfConfigFile(join(root, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })!;
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, types: [], lib: ["lib.esnext.d.ts"] });
  const endpoint = program.getSourceFile(join(root, "endpoints/stats/get.ts"));
  expect(ts.getPreEmitDiagnostics(program, endpoint).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))).toEqual([]);
});

/** Writes the init template's tsconfig into an existing linked project (its config is kept). */
async function initProjectFiles(root: string) {
  const scratch = join(createProject({}), "template");
  await initProject(scratch, { db: "memory" });
  for (const folder of ["entities", "hooks", "endpoints/stats"]) mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, "tsconfig.json"), readFileSync(join(scratch, "tsconfig.json"), "utf8"));
}
