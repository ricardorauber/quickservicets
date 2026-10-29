import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { build } from "../build/build.ts";
import { createProject } from "../testing/project.ts";
import { run } from "../run.ts";
import { DATABASES, initProject } from "./init.ts";

const read = (root: string, file: string) => readFileSync(join(root, file), "utf8");
const emptyDir = () => join(createProject({}), "my-api");

describe("files for each database", () => {
  test.each([
    ["postgres", "postgresAdapter({ url: process.env.DATABASE_URL! })", "DATABASE_URL=postgres://user:password@localhost:5432/app\n"],
    ["mongodb", "mongodbAdapter({ url: process.env.DATABASE_URL!, database: process.env.DATABASE_NAME! })", "DATABASE_URL=mongodb://localhost:27017\nDATABASE_NAME=app\n"],
    ["sqlite", "sqliteAdapter({ path: process.env.DATABASE_PATH! })", "DATABASE_PATH=data.db\n"],
    ["memory", "memoryAdapter()", ""],
  ])("%s", async (db, adapter, env) => {
    const root = emptyDir();
    await initProject(root, { db });
    expect(read(root, "quickservicets.config.ts")).toContain(adapter);
    expect(read(root, ".env")).toBe(env);
    for (const folder of ["entities", "endpoints", "hooks"]) expect(readdirSync(join(root, folder))).toEqual([".gitkeep"]);
    expect(existsSync(join(root, "tsconfig.json"))).toBe(true);
    const pkg = JSON.parse(read(root, "package.json"));
    expect(pkg.name).toBe("my-api");
    expect(Object.keys(pkg.dependencies)).toEqual(["@quickservicets/core", "@quickservicets/cli"]);
    expect(Object.keys(pkg.scripts)).toEqual(["dev", "build", "migrate", "start", "typecheck"]);
  });
});

test("the package.json adds Bun types and TypeScript at the repository's versions and a typecheck script", async () => {
  const rootManifest = JSON.parse(readFileSync(join(import.meta.dir, "../../../../package.json"), "utf8"));
  const root = emptyDir();
  await initProject(root, { db: "postgres" });
  const pkg = JSON.parse(read(root, "package.json"));
  expect(pkg.devDependencies).toEqual({ "@types/bun": rootManifest.devDependencies["@types/bun"], typescript: rootManifest.devDependencies.typescript });
  expect(pkg.scripts.typecheck).toBe("tsc --noEmit");
});

test("the tsconfig uses the Bun types and includes every convention folder, and the new project builds", async () => {
  const root = emptyDir();
  expect(await run(["init", root, "--db", "memory"], { log: () => {}, error: () => {} }, dirname(root))).toBe(0);
  const tsconfig = JSON.parse(read(root, "tsconfig.json"));
  expect(tsconfig.compilerOptions.types).toEqual(["bun"]);
  expect(tsconfig.include).toEqual(["quickservicets.config.ts", "entities", "endpoints", "hooks", "jobs", "features", "migrations", "lib", "tests", ".generated/**/*.ts"]);
  mkdirSync(join(root, "node_modules/@quickservicets"), { recursive: true });
  symlinkSync(join(import.meta.dir, "../../../core"), join(root, "node_modules/@quickservicets/core"), "dir");
  writeFileSync(join(root, "entities/Post.ts"), "export type Post = { title: string };\n");
  expect((await build(root)).entities).toBe(1);
});

test("the .gitignore keeps secrets, dependencies and generated files out of git", async () => {
  const root = emptyDir();
  await initProject(root, { db: "sqlite" });
  expect(read(root, ".gitignore").split("\n").filter(Boolean)).toEqual([".env", "node_modules/", ".generated/", "uploads/", "data.db"]);
});

test("a non-empty directory is rejected and nothing is written", async () => {
  const root = createProject({ "README.md": "hi" });
  const errors: string[] = [];
  expect(await run(["init", "--db", "sqlite"], { log: () => {}, error: (line) => errors.push(line) }, root)).toBe(1);
  expect(errors).toEqual(["Directory is not empty"]);
  expect(readdirSync(root)).toEqual(["README.md"]);
});

test("an unknown --db is rejected", async () => {
  const errors: string[] = [];
  expect(await run(["init", "x", "--db", "oracle"], { log: () => {}, error: (line) => errors.push(line) }, createProject({}))).toBe(1);
  expect(errors[0]).toContain("oracle");
});

test("without --db the prompt offers the four databases", async () => {
  let offered: readonly string[] = [];
  const root = emptyDir();
  await initProject(root, {
    prompt: async (question, choices) => {
      offered = choices;
      expect(question).toBe("Which database?");
      return "sqlite";
    },
  });
  expect(offered).toEqual(DATABASES);
  expect(read(root, "quickservicets.config.ts")).toContain("sqliteAdapter");
});

test("prints the next steps and creates the target directory", async () => {
  const parent = createProject({});
  const logs: string[] = [];
  expect(await run(["init", "my-api", "--db", "memory"], { log: (line) => logs.push(line), error: () => {} }, parent)).toBe(0);
  expect(logs.join("\n")).toMatch(/bun install[\s\S]*entities\/User\.ts[\s\S]*bun run dev/);
  expect(existsSync(join(parent, "my-api/quickservicets.config.ts"))).toBe(true);
});

test("a new project builds once it has an entity", async () => {
  const root = emptyDir();
  await initProject(root, { db: "sqlite" });
  mkdirSync(join(root, "node_modules/@quickservicets"), { recursive: true });
  symlinkSync(join(import.meta.dir, "../../../core"), join(root, "node_modules/@quickservicets/core"), "dir");
  writeFileSync(join(root, "entities/User.ts"), "export type User = { email: string }");
  process.env.DATABASE_PATH = join(root, "data.db");
  try {
    expect(await run(["build"], { log: () => {}, error: () => {} }, root)).toBe(0);
  } finally {
    delete process.env.DATABASE_PATH;
  }
  expect(existsSync(join(root, ".generated/server.ts"))).toBe(true);
});

test("every file init writes uses the @quickservicets packages and quickservicets.config.ts", async () => {
  for (const db of DATABASES) {
    const root = emptyDir();
    await initProject(root, { db });
    expect(read(root, "quickservicets.config.ts")).toContain('from "@quickservicets/core"');
    const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
    for (const entry of files) {
      const text = readFileSync(join(entry.parentPath, entry.name), "utf8");
      // The previous lowercase name, spelled in parts so this file does not contain it.
      expect(text).not.toMatch(new RegExp(`${["quick", "service"].join("")}(?!ts)`));
    }
    const pkg = JSON.parse(read(root, "package.json"));
    expect(Object.keys(pkg.dependencies)).toEqual(["@quickservicets/core", "@quickservicets/cli"]);
  }
});

test("the config says security is on by default and shows how to enable natives, and the project still builds", async () => {
  for (const db of DATABASES) {
    const root = emptyDir();
    await initProject(root, { db });
    const config = read(root, "quickservicets.config.ts");
    expect(config).toContain("// security is on by default with safe defaults");
    expect(config).toContain("// events: {},");
    expect(config).toContain("// history: {},");
  }
  const root = emptyDir();
  await initProject(root, { db: "memory" });
  mkdirSync(join(root, "node_modules/@quickservicets"), { recursive: true });
  symlinkSync(join(import.meta.dir, "../../../core"), join(root, "node_modules/@quickservicets/core"), "dir");
  expect((await build(root)).entities).toBe(0);
});
