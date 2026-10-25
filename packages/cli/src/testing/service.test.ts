import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestService } from "@quickservice/cli/testing";

const CONFIG = (keys = "") => `import { defineConfig, memoryAdapter } from "@quickservice/core";
export default defineConfig({ database: memoryAdapter()${keys ? `, ${keys}` : ""} });
`;
const POST = "export type Post = { title: string };\n";
const temporaryProjects = () => readdirSync(tmpdir()).filter((name) => name.startsWith("quickservice-test-"));
const failure = async (work: () => Promise<unknown>): Promise<Error> => {
  try {
    await work();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure");
};
const ticker = (clear: boolean) => `import { defineFeature } from "@quickservice/core";
export default defineFeature({ docs: { summary: "Test native." }, key: "ticker", setup(ctx) {
  let timer: ReturnType<typeof setInterval> | undefined;
  ctx.app.onStart(() => { timer = setInterval(() => {}, 1000); });
  ${clear ? "ctx.app.onStop(() => clearInterval(timer));" : ""}
} });
`;

describe("starting a project", () => {
  test("fetch calls the app without a port and repos reads what it wrote", async () => {
    const service = await startTestService({ files: { "quickservice.config.ts": CONFIG(), "entities/Post.ts": POST } });
    try {
      const created = await service.fetch("/posts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Hi" }) });
      expect(created.status).toBe(201);
      const posts = (service.repos as unknown as { posts: { query(): { all(): Promise<{ title: string }[]> } } }).posts;
      expect((await posts.query().all()).map((post) => post.title)).toEqual(["Hi"]);
      expect(((await (await service.fetch("/posts?limit=1")).json()) as { total: number }).total).toBe(1);
      expect(existsSync(join(service.root, ".generated/server.ts"))).toBe(true);
    } finally {
      await service.stop();
    }
  });

  test("the environment reaches the build and the service, and the database is always the memory adapter", async () => {
    const feature = `import { defineFeature, object, string } from "@quickservice/core";
export default defineFeature({ docs: { summary: "Test native." }, key: "greeting", options: object({ text: string().default("Hi") }), setup(ctx) {
  ctx.app.route("GET", "/greeting", () => ({ text: ctx.options.text }));
} });
`;
    const files = { "quickservice.config.ts": CONFIG().replace("memoryAdapter()", 'sqliteAdapter({ path: "never-created.db" })').replace("memoryAdapter }", "memoryAdapter, sqliteAdapter }"), "features/greeting/index.ts": feature };
    const service = await startTestService({ files, env: { QS_GREETING_ENABLED: "true", QS_GREETING_TEXT: "Hello" } });
    try {
      expect(await (await service.fetch("/greeting")).json()).toEqual({ text: "Hello" });
      expect(existsSync(join(service.root, "never-created.db"))).toBe(false);
    } finally {
      await service.stop();
    }
  });
});

describe("stopping", () => {
  test("stop removes the folder after the shutdown sequence", async () => {
    const service = await startTestService({ files: { "quickservice.config.ts": CONFIG("ticker: {}"), "features/ticker/index.ts": ticker(true) } });
    await service.stop();
    expect(existsSync(service.root)).toBe(false);
  });

  test("a timer a feature started in onStart and never cleared fails stop naming the feature and phase", async () => {
    const service = await startTestService({ files: { "quickservice.config.ts": CONFIG("ticker: {}"), "features/ticker/index.ts": ticker(false) } });
    expect((await failure(() => service.stop())).message).toBe("A timer created by ticker in onStart is still active after onStop");
    expect(existsSync(service.root)).toBe(false);
    expect(globalThis.setInterval.name).not.toBe("");
  });
});

describe("failures", () => {
  test("a build error rejects with the build output and leaves no folder", async () => {
    const before = temporaryProjects();
    const error = await failure(() => startTestService({ files: { "quickservice.config.ts": CONFIG(), "entities/Post.ts": "export type Post = { title: Strng };\n" } }));
    expect(error.message).toBe('Build failed:\nentities/Post.ts: field "title" has unsupported type "Strng"');
    expect(temporaryProjects()).toEqual(before);
  });

  test("a startup error rejects with it and leaves no folder", async () => {
    const before = temporaryProjects();
    const broken = 'import { defineFeature } from "@quickservice/core";\nexport default defineFeature({ docs: { summary: "Test native." }, key: "broken", setup() { throw new Error("no key"); } });\n';
    const error = await failure(() => startTestService({ files: { "quickservice.config.ts": CONFIG("broken: {}"), "features/broken/index.ts": broken } }));
    expect(error.message).toBe("Startup failed: broken failed in setup: no key");
    expect(temporaryProjects()).toEqual(before);
  });
});

describe("minimal example workspaces", () => {
  const repository = join(import.meta.dir, "../../../..");

  test("examples/minimal/* are workspaces depending on the workspace packages, with tests the root suite runs", async () => {
    const root = JSON.parse(readFileSync(join(repository, "package.json"), "utf8")) as { workspaces: string[] };
    expect(root.workspaces).toContain("examples/minimal/*");
    const demo = JSON.parse(readFileSync(join(repository, "examples/minimal/demo/package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(demo.dependencies).toEqual({ "@quickservice/core": "workspace:*", "@quickservice/cli": "workspace:*" });
    expect(existsSync(join(repository, "examples/minimal/demo/tests/demo.test.ts"))).toBe(true);
    const child = Bun.spawn(["bun", "test", "examples/minimal/demo"], { cwd: repository, stdout: "pipe", stderr: "pipe" });
    const [, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0);
    expect(stderr).toContain("1 pass");
  });
});
