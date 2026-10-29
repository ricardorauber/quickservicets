import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { build } from "../build/build.ts";
import { createProject } from "../testing/project.ts";
import { run } from "../run.ts";
import { loadConfig } from "@quickservicets/core";
import { DATABASES, DEFAULT_DATABASE, initProject, MEMORY_NOTES, NEXT_STEPS, nextSteps } from "./init.ts";

const read = (root: string, file: string) => readFileSync(join(root, file), "utf8");
const emptyDir = () => join(createProject({}), "my-api");
/** Whether a config is the memory project's: only `defineConfig` imported and no database outside the comments. */
const isMemoryConfig = (config: string) =>
  config.startsWith('import { defineConfig } from "@quickservicets/core";\n') &&
  !config.split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n").includes("database") &&
  config.includes("in-memory database");
const linkCore = (root: string) => {
  mkdirSync(join(root, "node_modules/@quickservicets"), { recursive: true });
  symlinkSync(join(import.meta.dir, "../../../core"), join(root, "node_modules/@quickservicets/core"), "dir");
};

describe("files for each database", () => {
  test.each([
    ["postgres", "postgresAdapter({ url: process.env.DATABASE_URL! })", "DATABASE_URL=postgres://user:password@localhost:5432/app\n"],
    ["mongodb", "mongodbAdapter({ url: process.env.DATABASE_URL!, database: process.env.DATABASE_NAME! })", "DATABASE_URL=mongodb://localhost:27017\nDATABASE_NAME=app\n"],
    ["sqlite", "sqliteAdapter({ path: process.env.DATABASE_PATH! })", "DATABASE_PATH=data.db\n"],
    ["memory", "export default defineConfig({", ""],
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

describe("the database choice", () => {
  test.each([true, false])("without --db, interactive %p, init asks nothing and writes the memory project", async (interactive) => {
    const parent = createProject({});
    const asked: string[] = [];
    const io = { interactive, ask: async (question: string) => (asked.push(question), "sqlite") };
    expect(await run(["init", "demo"], { log: () => {}, error: () => {} }, parent, undefined, io)).toBe(0);
    expect(asked).toEqual([]);
    expect(isMemoryConfig(read(join(parent, "demo"), "quickservicets.config.ts"))).toBe(true);
    expect(read(join(parent, "demo"), ".env")).toBe("");
  });

  test("initProject without db uses memory, and --db picks another or fails as before", async () => {
    const root = emptyDir();
    await initProject(root);
    expect(isMemoryConfig(read(root, "quickservicets.config.ts"))).toBe(true);
    expect(DEFAULT_DATABASE).toBe("memory");
    const parent = createProject({});
    expect(await run(["init", "lite", "--db", "sqlite"], { log: () => {}, error: () => {} }, parent)).toBe(0);
    expect(read(join(parent, "lite"), "quickservicets.config.ts")).toContain("sqliteAdapter({ path: process.env.DATABASE_PATH! })");
    expect(read(join(parent, "lite"), ".env")).toBe("DATABASE_PATH=data.db\n");
    const errors: string[] = [];
    expect(await run(["init", "bad", "--db", "nope"], { log: () => {}, error: (line) => errors.push(line) }, parent)).toBe(1);
    expect(errors).toEqual([`Unknown database "nope" (use ${DATABASES.join(", ")})`]);
  });
});

describe("the memory config", () => {
  test("imports only defineConfig, names no database and explains how to switch", async () => {
    const root = emptyDir();
    await initProject(root, { db: "memory" });
    const config = read(root, "quickservicets.config.ts");
    expect(config.split("\n").filter((line) => line.startsWith("import "))).toEqual(['import { defineConfig } from "@quickservicets/core";']);
    // No database key outside the comments.
    expect(config.split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n")).not.toContain("database");
    expect(config).toContain("in-memory database, which loses its data on every restart");
    expect(config).toContain('//   database: sqliteAdapter({ path: process.env.DATABASE_PATH ?? "data.db" }),');
    expect(config).toContain("init --db sqlite");
    expect(config).toContain("// security is on by default with safe defaults");
    expect(config).toContain("// events: {},");
  });

  test("builds exactly like a project without a config file, and the switch line works when uncommented", async () => {
    const withConfig = emptyDir();
    await initProject(withConfig, { db: "memory", agents: false });
    linkCore(withConfig);
    writeFileSync(join(withConfig, "entities/Post.ts"), "export type Post = { title: string };\n");
    const without = createProject({ "entities/Post.ts": "export type Post = { title: string };\n", "package.json": read(withConfig, "package.json") });
    linkCore(without);
    await build(withConfig);
    await build(without);
    for (const file of ["models.ts", "routes.ts", "openapi.json", "types.ts"]) expect(read(withConfig, `.generated/${file}`)).toBe(read(without, `.generated/${file}`));
    expect((await loadConfig(withConfig, {})).database.kind).toBe("memory");
    // Uncommenting the switch line inside defineConfig, with its import, gives a SQLite project.
    const config = read(withConfig, "quickservicets.config.ts");
    const line = config.split("\n").find((entry) => entry.startsWith("//   database:"))!.replace("//   ", "  ");
    const switched = config
      .replace("import { defineConfig } from", "import { defineConfig, sqliteAdapter } from")
      .replace("export default defineConfig({\n", `export default defineConfig({\n${line}\n`);
    const sqliteRoot = createProject({ "quickservicets.config.ts": switched });
    linkCore(sqliteRoot);
    expect((await loadConfig(sqliteRoot, { DATABASE_PATH: join(sqliteRoot, "data.db") })).database.kind).toBe("sqlite");
  });
});

test("prints the next steps and creates the target directory", async () => {
  const parent = createProject({});
  const logs: string[] = [];
  expect(await run(["init", "my-api", "--db", "memory"], { log: (line) => logs.push(line), error: () => {} }, parent)).toBe(0);
  expect(logs.join("\n")).toMatch(/bun install[\s\S]*entities\/User\.ts[\s\S]*bun run dev/);
  expect(existsSync(join(parent, "my-api/quickservicets.config.ts"))).toBe(true);
});

test("the next steps of a memory project mention the in-memory database and --db; the other databases' do not", async () => {
  const parent = createProject({});
  const logs: string[] = [];
  expect(await run(["init", "my-api"], { log: (line) => logs.push(line), error: () => {} }, parent)).toBe(0);
  expect(logs).toEqual([...NEXT_STEPS, ...MEMORY_NOTES]);
  expect(logs.join("\n")).toContain("in-memory database: no migrations are needed");
  expect(logs.join("\n")).toContain("--db sqlite, postgres or mongodb");
  expect(nextSteps("sqlite")).toEqual(NEXT_STEPS);
  expect(nextSteps("postgres").join("\n")).not.toContain("in-memory");
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

test("a fresh project, linked to the workspace packages, builds 0 entities and bun run dev serves it", async () => {
  const root = emptyDir();
  await initProject(root);
  linkCore(root);
  symlinkSync(join(import.meta.dir, "../.."), join(root, "node_modules/@quickservicets/cli"), "dir");
  mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
  symlinkSync(join(import.meta.dir, "../index.ts"), join(root, "node_modules/.bin/quickservicets"));
  const logs: string[] = [];
  expect(await run(["build"], { log: (line) => logs.push(line), error: () => {} }, root)).toBe(0);
  expect(logs).toEqual(["Built 0 entities, 0 custom endpoints and 0 hooks."]);
  // The service listens on 3000 by default; the test moves it to a free port with PORT, as the docs show.
  expect((await loadConfig(root, {})).server.port).toBe(3000);
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  const child = Bun.spawn(["bun", "run", "dev"], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: "development" }, stdout: "pipe", stderr: "pipe" });
  let output = "";
  const decoder = new TextDecoder();
  const read = (async () => {
    for await (const chunk of child.stdout) output += decoder.decode(chunk, { stream: true });
  })();
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !output.includes(`listening on http://localhost:${port}`)) await Bun.sleep(50);
    expect(output).toContain("Built 0 entities, 0 custom endpoints and 0 hooks.");
    expect(output).toContain(`QuickService.ts listening on http://localhost:${port}`);
    expect((await fetch(`http://localhost:${port}/docs`)).status).toBe(200);
    for (const path of ["/files", "/media"]) expect((await fetch(`http://localhost:${port}${path}`)).status).toBe(404);
  } finally {
    child.kill("SIGTERM");
    await child.exited;
    await read.catch(() => undefined);
  }
  // Stopping dev stops the server it started.
  const deadline = Date.now() + 5_000;
  let open = true;
  while (open && Date.now() < deadline) {
    open = await fetch(`http://localhost:${port}/docs`).then(() => true, () => false);
    if (open) await Bun.sleep(100);
  }
  expect(open).toBe(false);
}, 60_000);
