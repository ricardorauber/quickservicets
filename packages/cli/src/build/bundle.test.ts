import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetPath, bundledAssets, setAssetsRoot, setEmbeddedAssets } from "@quickservicets/core";
import { run } from "../run.ts";
import { createLinkedProject } from "../testing/project.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const SQLITE = `import { defineConfig, sqliteAdapter } from "@quickservicets/core";
export default defineConfig({ database: sqliteAdapter({ path: process.env.DATABASE_PATH ?? "data.db" }), health: {} });
`;

/** An endpoint listing the migration files it finds through assetPath. */
const LISTING = `import { readdirSync } from "node:fs";
import { assetPath } from "@quickservicets/core";
export default () => ({ files: readdirSync(assetPath("migrations")).filter((file) => file.endsWith(".ts")).sort() });
`;

const project = (files: Record<string, string> = {}) => {
  const root = createLinkedProject({ "package.json": JSON.stringify({ name: "@acme/blog" }), "quickservicets.config.ts": SQLITE, "entities/Post.ts": "export type Post = { title: string };\n", "endpoints/assets/get.ts": LISTING, ...files });
  roots.push(root);
  return root;
};

/** Runs the CLI in a project, its SQLite file inside the project (the config reads DATABASE_PATH when it loads). */
const cli = async (args: string[], root: string) => {
  const out: string[] = [];
  const err: string[] = [];
  const previous = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(root, "data.db");
  try {
    const code = await run(args, { log: (line) => out.push(line), error: (line) => err.push(line) }, root);
    return { code, out, err };
  } finally {
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
  }
};

/** A folder holding only a copy of the given path. */
const alone = (source: string, name: string) => {
  const dir = mkdtempSync(join(tmpdir(), "qs-alone-"));
  roots.push(dir);
  cpSync(source, join(dir, name), { recursive: true });
  return dir;
};

const freePort = () => {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
};

/** Starts a command that serves, waits for its listening line and resolves its URL and a stop function. */
async function serve(command: string[], cwd: string): Promise<{ url: string; stop(): Promise<void> }> {
  const port = freePort();
  const child = Bun.spawn(command, { cwd, env: { PATH: process.env.PATH ?? "", PORT: String(port), HOME: process.env.HOME ?? "" }, stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  let text = "";
  const deadline = Date.now() + 30_000;
  while (!/listening on \S+/.test(text) && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  if (!/listening on \S+/.test(text)) {
    child.kill();
    throw new Error(`no listening line: ${text}${await new Response(child.stderr).text()}`);
  }
  return {
    url: `http://localhost:${port}`,
    async stop() {
      child.kill();
      await child.exited;
    },
  };
}

describe("the server bundle and its assets", () => {
  test("server.js with its source map and assets starts alone, migrates and serves from its assets", async () => {
    const root = project();
    expect((await cli(["migration", "add", "CreatePosts"], root)).code).toBe(0);
    const built = await cli(["build"], root);
    expect(built.code).toBe(0);
    const dist = join(root, "dist/server");
    expect(readdirSync(dist).sort()).toEqual(["assets", "server.js", "server.js.map"]);
    expect(readFileSync(join(dist, "server.js"), "utf8")).toContain("//# sourceMappingURL=server.js.map");
    const migration = readdirSync(join(root, "migrations")).find((file) => file.endsWith(".ts"))!;
    expect(existsSync(join(dist, "assets/migrations", migration))).toBe(true);
    expect(existsSync(join(dist, "assets/.generated/openapi.json"))).toBe(true);
    const folder = alone(dist, "server");
    const migrate = Bun.spawnSync([process.execPath, "server/server.js", "migrate"], { cwd: folder, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" });
    expect(migrate.exitCode).toBe(0);
    expect(migrate.stdout.toString()).toContain(`Applied ${migration.slice(0, -3)}`);
    const server = await serve([process.execPath, "server/server.js"], folder);
    try {
      expect((await fetch(`${server.url}/posts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Bundled" }) })).status).toBe(201);
      expect(((await (await fetch(`${server.url}/posts`)).json()) as { total: number }).total).toBe(1);
      expect(await (await fetch(`${server.url}/assets`)).json()).toEqual({ files: [migration] });
    } finally {
      await server.stop();
    }
  }, 120_000);

  test("files a feature lists in assets and its build output are copied", async () => {
    const root = project({
      "templates/welcome.txt": "Hello\n",
      "features/mailer/index.ts": `import { defineFeature } from "@quickservicets/core";
export default defineFeature({ key: "mailer", enabledByDefault: true, assets: ["templates"], build(ctx) { ctx.write("subjects.json", "{}"); } });
`,
    });
    expect((await cli(["build"], root)).code).toBe(0);
    expect(readFileSync(join(root, "dist/server/assets/templates/welcome.txt"), "utf8")).toBe("Hello\n");
    expect(existsSync(join(root, "dist/server/assets/.generated/mailer/subjects.json"))).toBe(true);
  }, 60_000);
});

describe("assetPath", () => {
  afterEach(() => setAssetsRoot(undefined));

  test("reads from the project without a bundle, from the assets folder in a bundle, and from embedded files in a binary", () => {
    expect(bundledAssets()).toBe(false);
    expect(assetPath("migrations")).toBe(join(process.cwd(), "migrations"));
    setAssetsRoot("/srv/app/assets");
    expect(bundledAssets()).toBe(true);
    expect(assetPath("migrations")).toBe("/srv/app/assets/migrations");
    const source = join(mkdtempSync(join(tmpdir(), "qs-embedded-")), "one.ts");
    roots.push(join(source, ".."));
    writeFileSync(source, "export default 1;\n");
    setEmbeddedAssets({ "migrations/20260101000000_One.ts": source });
    expect(readdirSync(assetPath("migrations"))).toEqual(["20260101000000_One.ts"]);
    expect(readFileSync(assetPath("migrations/20260101000000_One.ts"), "utf8")).toBe("export default 1;\n");
  });

  test("in a normal project run the listing comes from the project's migrations folder", async () => {
    const root = project();
    expect((await cli(["migration", "add", "CreatePosts"], root)).code).toBe(0);
    expect((await cli(["build"], root)).code).toBe(0);
    const migrated = await cli(["migrate"], root);
    expect(migrated.err).toEqual([]);
    expect(migrated.code).toBe(0);
    const server = await serve([process.execPath, ".generated/server.ts"], root);
    try {
      const migration = readdirSync(join(root, "migrations")).find((file) => file.endsWith(".ts"))!;
      expect(await (await fetch(`${server.url}/assets`)).json()).toEqual({ files: [migration] });
    } finally {
      await server.stop();
    }
  }, 60_000);
});

describe("the binary", () => {
  test("the executable starts with no other file, answers /health/live, and migrate applies a pending migration", async () => {
    const root = project();
    expect((await cli(["migration", "add", "CreatePosts"], root)).code).toBe(0);
    const built = await cli(["build", "--target", "binary"], root);
    expect(built.code).toBe(0);
    expect(readdirSync(join(root, "dist/binary"))).toEqual(["blog"]);
    const folder = alone(join(root, "dist/binary/blog"), "blog");
    chmodSync(join(folder, "blog"), 0o755);
    const migrate = Bun.spawnSync(["./blog", "migrate"], { cwd: folder, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" });
    expect(migrate.stderr.toString()).toBe("");
    expect(migrate.exitCode).toBe(0);
    expect(migrate.stdout.toString()).toContain("Applied ");
    expect(existsSync(join(folder, "data.db"))).toBe(true);
    const server = await serve(["./blog"], folder);
    try {
      expect((await fetch(`${server.url}/health/live`)).status).toBe(200);
      expect((await fetch(`${server.url}/posts`)).status).toBe(200);
      const migration = readdirSync(join(root, "migrations")).find((file) => file.endsWith(".ts"))!;
      expect(await (await fetch(`${server.url}/assets`)).json()).toEqual({ files: [migration] });
    } finally {
      await server.stop();
    }
  }, 180_000);
});

describe("external modules and unbundleable ones", () => {
  /** A package with a native addon, imported by an endpoint. */
  const addonProject = (config = SQLITE) => {
    const root = project({ "quickservicets.config.ts": config, "endpoints/addon/get.ts": 'import addon from "fake-addon";\nexport default () => ({ loaded: typeof addon });\n' });
    const pkg = join(root, "node_modules/fake-addon");
    mkdirSync(join(pkg, "build/Release"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "fake-addon", main: "index.js" }));
    writeFileSync(join(pkg, "index.js"), 'module.exports = require("./build/Release/addon.node");\n');
    writeFileSync(join(pkg, "build/Release/addon.node"), "not a real addon");
    return root;
  };

  test("a native addon fails the build naming its package; listed in deploy.external the server target builds", async () => {
    const failing = await cli(["build"], addonProject());
    expect(failing.code).toBe(1);
    expect(failing.err).toEqual(["fake-addon cannot be bundled for server; add it to deploy.external and ship it next to the bundle"]);
    const external = SQLITE.replace("health: {} }", 'health: {}, deploy: { external: ["fake-addon"] } }');
    const root = addonProject(external);
    expect((await cli(["build"], root)).code).toBe(0);
    expect(readFileSync(join(root, "dist/server/server.js"), "utf8")).toContain("fake-addon");
    const binary = await cli(["build", "--target", "binary"], root);
    expect(binary.code).toBe(1);
    expect(binary.err).toEqual(["fake-addon cannot be bundled for binary; binary targets cannot load external modules; use the server target"]);
  }, 60_000);
});

describe("sizes", () => {
  test("the build prints the size and the five largest modules, and --analyze writes the report", async () => {
    const root = project();
    const built = await cli(["build", "--analyze"], root);
    expect(built.code).toBe(0);
    const at = built.out.findIndex((line) => line.startsWith("Target server: dist/server/ ("));
    expect(built.out[at + 1]).toBe("Largest modules:");
    const largest = built.out.slice(at + 2, at + 7);
    expect(largest).toHaveLength(5);
    for (const line of largest) expect(line).toMatch(/^ {2}\S+ \(\d+(\.\d)? (B|KB|MB)\)$/);
    const report = JSON.parse(readFileSync(join(root, "dist/server/bundle-report.json"), "utf8")) as { target: string; size: number; modules: { path: string; bytes: number }[] };
    expect(report.target).toBe("server");
    expect(report.modules.length).toBeGreaterThan(5);
    expect(report.modules[0]!.bytes).toBeGreaterThanOrEqual(report.modules[1]!.bytes);
  }, 60_000);
});
