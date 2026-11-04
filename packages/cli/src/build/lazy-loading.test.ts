import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServiceHandler, memoryAdapter, mongodbAdapter, type LogEntry, type ServiceConfig, type StartServiceOptions } from "@quickservicets/core";
import { createLinkedProject } from "../testing/project.ts";
import { build } from "./build.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const CONFIG = (deploy: string) => `import { defineConfig } from "@quickservicets/core";\nexport default defineConfig({ deploy: ${deploy} });\n`;

/** An endpoint whose module records that it was imported. */
const recording = (name: string) => `const loaded = ((globalThis as { __qsLoaded?: string[] }).__qsLoaded ??= []);
loaded.push(${JSON.stringify(name)});
export default () => ({ name: ${JSON.stringify(name)} });
`;

/** Builds a project and returns its root and the inputs its generated server passes to startService. */
async function generated(files: Record<string, string>, env: Record<string, string> = {}): Promise<{ root: string; inputs: Omit<StartServiceOptions, "projectConfig"> }> {
  const root = createLinkedProject({ "entities/Post.ts": "export type Post = { title: string };\n", ...files });
  roots.push(root);
  await build(root, env);
  const dir = join(root, ".generated");
  const { models } = await import(join(dir, "models.ts"));
  const { crudRoutes, endpoints, hooks } = await import(join(dir, "routes.ts"));
  const { jobs } = await import(join(dir, "jobs.ts"));
  const { features, featureFolders } = await import(join(dir, "features.ts"));
  const config = (await import(join(root, "quickservicets.config.ts"))).default as ServiceConfig;
  return { root, inputs: { projectConfig: config, models, crudRoutes, endpoints, hooks, jobs, features, featureFolders, generatedDir: dir, env } as never };
}

const recorder = () => {
  const entries: LogEntry[] = [];
  const keep = (entry: LogEntry) => void entries.push(entry);
  return { entries, logger: { info: keep, warn: keep, error: keep } };
};

const handlerOf = (inputs: Omit<StartServiceOptions, "projectConfig">, extra: Partial<StartServiceOptions> = {}, logger = recorder().logger) =>
  createServiceHandler({ ...inputs, ...extra, projectConfig: { ...((inputs as StartServiceOptions).projectConfig ?? {}), database: memoryAdapter(), logger } as ServiceConfig, handleSigterm: false });

describe("driver import boundaries", () => {
  test("importing the core or creating a MongoDB adapter loads no driver", () => {
    const core = join(import.meta.dir, "../../../core/src/index.ts");
    const script = `const core = await import(${JSON.stringify(core)});
core.mongodbAdapter({ url: "mongodb://localhost:27017", database: "app" });
core.postgresAdapter({ url: "postgres://localhost/app" });
console.log(JSON.stringify(Object.keys(require.cache).filter((key) => /node_modules\\/(mongodb|bson)\\//.test(key))));`;
    const child = Bun.spawnSync([process.execPath, "-e", script], { cwd: join(import.meta.dir, "../../../core"), stdout: "pipe", stderr: "pipe" });
    expect(child.stderr.toString()).toBe("");
    expect(JSON.parse(child.stdout.toString().trim())).toEqual([]);
  });

  test.skipIf(!process.env.TEST_MONGODB_URL)("a MongoDB adapter still connects, loading its driver then", async () => {
    const adapter = mongodbAdapter({ url: process.env.TEST_MONGODB_URL!, database: "qs_b13_lazy" });
    await adapter.connect([], {});
    try {
      await adapter.ping?.();
    } finally {
      await adapter.disconnect();
    }
  });
});

describe("lazy routes", () => {
  test("with lazyRoutes on, only the requested endpoint's module is imported, and only once", async () => {
    const { root, inputs } = await generated({ "quickservicets.config.ts": CONFIG('{ lazyRoutes: "on" }'), "endpoints/alpha/get.ts": recording("alpha"), "endpoints/beta/get.ts": recording("beta") });
    expect(readFileSync(join(root, ".generated/routes.ts"), "utf8")).toContain('lazyEndpoint("endpoints/alpha/get.ts", () => import("../endpoints/alpha/get.ts"))');
    const loaded = ((globalThis as { __qsLoaded?: string[] }).__qsLoaded ??= []);
    loaded.length = 0;
    const handler = handlerOf(inputs);
    try {
      await handler.init();
      expect(loaded).toEqual([]);
      expect(await (await handler.fetch(new Request("http://x/alpha"))).json()).toEqual({ name: "alpha" });
      expect(await (await handler.fetch(new Request("http://x/alpha"))).json()).toEqual({ name: "alpha" });
      expect(loaded).toEqual(["alpha"]);
    } finally {
      await handler.stop();
    }
  });

  test("auto loads lazily for function and Cloud Run targets, and off keeps the static imports", async () => {
    const auto = await generated({ "quickservicets.config.ts": CONFIG('{ target: "lambda" }'), "endpoints/alpha/get.ts": recording("alpha") });
    expect(readFileSync(join(auto.root, ".generated/routes.ts"), "utf8")).toContain("lazyEndpoint(");
    const server = await generated({ "quickservicets.config.ts": CONFIG("{}"), "endpoints/alpha/get.ts": recording("alpha") });
    expect(readFileSync(join(server.root, ".generated/routes.ts"), "utf8")).toContain('import endpoint0 from "../endpoints/alpha/get.ts";');
    const off = await generated({ "quickservicets.config.ts": CONFIG('{ target: "lambda", lazyRoutes: "off" }'), "endpoints/alpha/get.ts": recording("alpha") });
    expect(readFileSync(join(off.root, ".generated/routes.ts"), "utf8")).not.toContain("lazyEndpoint(");
  });

  test("a module that throws at import answers 500 for its route only, logs routes.load.failed, and is tried again", async () => {
    const { inputs } = await generated({
      "quickservicets.config.ts": CONFIG('{ lazyRoutes: "on" }'),
      "endpoints/broken/get.ts": 'const state = ((globalThis as { __qsBroken?: { tries: number } }).__qsBroken ??= { tries: 0 });\nstate.tries++;\nthrow new Error("cannot load");\nexport default () => ({});\n',
      "endpoints/fine/get.ts": "export default () => ({ fine: true });\n",
    });
    const { entries, logger } = recorder();
    const handler = handlerOf(inputs, {}, logger);
    try {
      const broken = await handler.fetch(new Request("http://x/broken"));
      expect(broken.status).toBe(500);
      expect(entries.find((entry) => entry.message === "routes.load.failed")).toMatchObject({ file: "endpoints/broken/get.ts", error: expect.objectContaining({ message: "cannot load" }) });
      expect((await handler.fetch(new Request("http://x/fine"))).status).toBe(200);
      expect((await handler.fetch(new Request("http://x/broken"))).status).toBe(500);
      // The second request imported the module again, and failed again.
      expect(entries.filter((entry) => entry.message === "routes.load.failed")).toHaveLength(2);
    } finally {
      await handler.stop();
    }
  });
});

describe("the lazy endpoint", () => {
  test("a failed import is retried on the next request, and a loaded module is kept", async () => {
    const { lazyEndpoint } = await import("@quickservicets/core");
    let calls = 0;
    const endpoint = lazyEndpoint("endpoints/x/get.ts", async () => {
      calls++;
      if (calls === 1) throw new Error("not yet");
      return { default: () => ({ ok: true }) };
    });
    const req = { id: "r1" } as never;
    await expect(Promise.resolve(endpoint({} as never, req, {} as never))).rejects.toThrow("Route failed to load");
    expect(await endpoint({} as never, req, {} as never)).toEqual({ ok: true });
    expect(await endpoint({} as never, req, {} as never)).toEqual({ ok: true });
    expect(calls).toBe(2);
  });
});

describe("lazy documents", () => {
  test("the OpenAPI document is read on the first request for it, not at startup", async () => {
    const { inputs } = await generated({ "quickservicets.config.ts": CONFIG("{}") });
    let reads = 0;
    const openApi = () => (reads++, { openapi: "3.1.0", info: { title: "Lazy" } });
    const handler = handlerOf(inputs, { openApi });
    try {
      await handler.init();
      expect((await handler.fetch(new Request("http://x/posts"))).status).toBe(200);
      expect(reads).toBe(0);
      expect(await (await handler.fetch(new Request("http://x/openapi.json"))).json()).toEqual({ openapi: "3.1.0", info: { title: "Lazy" } });
      expect(await (await handler.fetch(new Request("http://x/docs"))).text()).toContain("<title>Lazy API</title>");
      expect(reads).toBe(1);
    } finally {
      await handler.stop();
    }
  });
});

describe("startup timing", () => {
  test("service.started has the duration and the four phases, and the trace variable adds each feature's times", async () => {
    const plain = await generated({ "quickservicets.config.ts": CONFIG("{}") });
    const first = recorder();
    const handler = handlerOf(plain.inputs, {}, first.logger);
    await handler.init();
    await handler.stop();
    const started = first.entries.find((entry) => entry.message === "service.started")!;
    expect(started).toMatchObject({ durationMs: expect.any(Number), phases: { config: expect.any(Number), setup: expect.any(Number), connect: expect.any(Number), start: expect.any(Number) } });
    expect(started.features).toBeUndefined();
    const traced = await generated({ "quickservicets.config.ts": CONFIG("{}") }, { QS_DEPLOY_STARTUP_TRACE: "true" });
    const second = recorder();
    const tracing = handlerOf(traced.inputs, {}, second.logger);
    await tracing.init();
    await tracing.stop();
    const features = second.entries.find((entry) => entry.message === "service.started")!.features as Record<string, { setup?: number; onStart?: number }>;
    expect(Object.keys(features)).toContain("security");
    expect(features.security!.setup).toEqual(expect.any(Number));
  });
});
