import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
    expect(read(root, "quickservice.config.ts")).toContain(adapter);
    expect(read(root, ".env")).toBe(env);
    expect(read(root, ".gitignore")).toBe(".env\nnode_modules\n");
    for (const folder of ["entities", "endpoints", "hooks"]) expect(readdirSync(join(root, folder))).toEqual([".gitkeep"]);
    expect(existsSync(join(root, "tsconfig.json"))).toBe(true);
    const pkg = JSON.parse(read(root, "package.json"));
    expect(pkg.name).toBe("my-api");
    expect(Object.keys(pkg.dependencies)).toEqual(["@quickservice/core", "@quickservice/cli"]);
    expect(Object.keys(pkg.scripts)).toEqual(["dev", "build", "migrate", "start"]);
  });
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
  expect(read(root, "quickservice.config.ts")).toContain("sqliteAdapter");
});

test("prints the next steps and creates the target directory", async () => {
  const parent = createProject({});
  const logs: string[] = [];
  expect(await run(["init", "my-api", "--db", "memory"], { log: (line) => logs.push(line), error: () => {} }, parent)).toBe(0);
  expect(logs.join("\n")).toMatch(/bun install[\s\S]*entities\/User\.ts[\s\S]*bun run dev/);
  expect(existsSync(join(parent, "my-api/quickservice.config.ts"))).toBe(true);
});

test("a new project builds once it has an entity", async () => {
  const root = emptyDir();
  await initProject(root, { db: "sqlite" });
  mkdirSync(join(root, "node_modules/@quickservice"), { recursive: true });
  symlinkSync(join(import.meta.dir, "../../../core"), join(root, "node_modules/@quickservice/core"), "dir");
  writeFileSync(join(root, "entities/User.ts"), "export type User = { email: string }");
  process.env.DATABASE_PATH = join(root, "data.db");
  try {
    expect(await run(["build"], { log: () => {}, error: () => {} }, root)).toBe(0);
  } finally {
    delete process.env.DATABASE_PATH;
  }
  expect(existsSync(join(root, ".generated/server.ts"))).toBe(true);
});
