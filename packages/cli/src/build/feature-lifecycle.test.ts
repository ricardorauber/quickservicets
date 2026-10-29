import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerProjectFeatures, startService, type LogEntry, type RunningService, type ServiceConfig } from "@quickservicets/core";
import { createLinkedProject } from "../testing/project.ts";
import { build } from "./build.ts";

const config = (keys = "", database = "memoryAdapter()") => `import { defineConfig, memoryAdapter, postgresAdapter } from "@quickservicets/core";
export default defineConfig({ database: ${database}${keys ? `, ${keys}` : ""} });
`;
const feature = (key: string, body: string, extra = "") => `import { defineFeature } from "@quickservicets/core";
export default defineFeature({ docs: { summary: "Test native." }, key: "${key}", ${extra} async setup(ctx) {
${body}
} });
`;
const logging = (key: string, extra = "") =>
  feature(
    key,
    `  ctx.logger.info({ message: "setup ${key}" });
  ctx.app.onStart(() => ctx.logger.info({ message: "start ${key}" }));
  ctx.app.onShutdown(() => ctx.logger.info({ message: "shutdown ${key}" }));
  ctx.app.onStop(() => ctx.logger.info({ message: "stop ${key}" }));`,
    extra,
  );

const freePort = () => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
};

interface Started {
  service: RunningService | undefined;
  entries: LogEntry[];
  events: string[];
  exits: number[];
  url: string;
  signal(name: "SIGTERM" | "SIGINT"): Promise<number>;
}

const running: Started[] = [];
afterEach(async () => {
  for (const started of running.splice(0)) if (started.exits.length === 0 && started.service) await started.signal("SIGTERM");
  registerProjectFeatures([]);
});

/** Builds the project and starts it in this process with `startService`, recording log entries and exit codes. */
async function start(files: Record<string, string>, keys: string, env: Record<string, string> = {}, database?: string): Promise<Started> {
  const root = createLinkedProject({ "quickservicets.config.ts": config(keys, database), ...files });
  await build(root);
  const generated = join(root, ".generated");
  const projectConfig = (await import(join(root, "quickservicets.config.ts"))).default as ServiceConfig;
  const { models } = await import(join(generated, "models.ts"));
  const { crudRoutes, endpoints, hooks } = await import(join(generated, "routes.ts"));
  const { jobs } = await import(join(generated, "jobs.ts"));
  const { features, featureFolders } = await import(join(generated, "features.ts"));
  const openApi = (await import(join(generated, "openapi.json"))).default;
  const entries: LogEntry[] = [];
  const events: string[] = [];
  const record = (entry: LogEntry) => {
    entries.push(entry);
    if (typeof entry.message === "string" && /^(setup|start|shutdown|stop) /.test(entry.message)) events.push(entry.message);
  };
  const logger = { info: record, warn: record, error: record };
  const exits: number[] = [];
  const handlers = new Map<string, () => void>();
  const target = { once: (signal: string, handler: () => void) => void handlers.set(signal, handler), exit: (code: number) => void exits.push(code) };
  const port = freePort();
  const log = spyOn(console, "log").mockImplementation((line: unknown) => void events.push(String(line).startsWith("QuickService.ts listening") ? "listening" : String(line)));
  let service: RunningService | undefined;
  try {
    service = await startService({
      projectConfig: { ...projectConfig, logger },
      models,
      crudRoutes,
      endpoints,
      hooks,
      jobs,
      openApi,
      features,
      featureFolders,
      env: { QS_SERVER_PORT: String(port), ...env },
      process: target as never,
    });
  } finally {
    log.mockRestore();
  }
  const started: Started = {
    service,
    entries,
    events,
    exits,
    url: `http://localhost:${port}`,
    async signal(name) {
      handlers.get(name)?.();
      for (let tries = 0; tries < 200 && exits.length === 0; tries++) await Bun.sleep(10);
      return exits[0]!;
    },
  };
  running.push(started);
  return started;
}

describe("startService", () => {
  test("a project without features serves and stops as before", async () => {
    const started = await start({ "entities/Post.ts": "export type Post = { title: string };\n" }, "");
    const created = await fetch(`${started.url}/posts`, { method: "POST", body: JSON.stringify({ title: "Hi" }), headers: { "content-type": "application/json" } });
    expect(created.status).toBe(201);
    expect(started.events).toEqual(["listening"]);
    expect(await started.signal("SIGTERM")).toBe(0);
    expect((await fetch(`${started.url}/posts`).catch(() => undefined))?.status).toBeUndefined();
  });

  test("the generated server.ts is a few lines calling startService", async () => {
    const root = createLinkedProject({ "quickservicets.config.ts": config() });
    await build(root);
    const source = readFileSync(join(root, ".generated/server.ts"), "utf8");
    expect(source).toContain("await startService({ projectConfig, models, crudRoutes, endpoints, hooks, jobs, openApi, features, featureFolders, generatedDir: import.meta.dir });");
    expect(source.trim().split("\n").length).toBeLessThanOrEqual(12);
  });
});

describe("setup context", () => {
  test("setups and callbacks run in feature order with the feature on every entry, shutdown in reverse", async () => {
    const started = await start({ "features/a/index.ts": logging("a"), "features/b/index.ts": logging("b", 'requires: ["a"],') }, "b: {}, a: {}");
    expect(started.events).toEqual(["setup a", "setup b", "start a", "start b", "listening"]);
    expect(await started.signal("SIGTERM")).toBe(0);
    expect(started.events.slice(5)).toEqual(["shutdown b", "shutdown a", "stop b", "stop a"]);
    for (const entry of started.entries.filter((item) => typeof item.message === "string" && /^(setup|start|shutdown|stop) [ab]$/.test(item.message as string))) {
      expect(entry.feature).toBe((entry.message as string).slice(-1));
    }
  });

  test("the context holds the options, config, models, folders and worker, and onStart gets working repositories", async () => {
    const probe = feature(
      "probe",
      `  const seen = { options: ctx.options, models: ctx.models.map((model) => model.key), folders: [...(ctx.folders.notes?.keys() ?? [])], worker: ctx.worker, port: ctx.config.server.port };
  ctx.app.onStart(async ({ repos, server }) => {
    const post = await repos.posts.create({ title: "From onStart" });
    ctx.logger.info({ message: "start probe", seen, post: post.title, server: typeof server.fetch });
  });`,
      'options: object({ level: integer().default(2) }), folders: { notes: { dir: "notes", description: "Notes." } },',
    ).replace('import { defineFeature } from "@quickservicets/core";', 'import { defineFeature, integer, object } from "@quickservicets/core";');
    const started = await start({ "features/probe/index.ts": probe, "entities/Post.ts": "export type Post = { title: string };\n", "notes/first.ts": "export default 1;\n" }, "probe: {}");
    const entry = started.entries.find((item) => item.message === "start probe")!;
    expect(entry.seen).toMatchObject({ options: { level: 2, enabled: true }, models: ["Post"], folders: ["first"], worker: { index: 0, count: 1, runsScheduledWork: true } });
    expect([entry.post, entry.server]).toEqual(["From onStart", "function"]);
    expect(((await (await fetch(`${started.url}/posts`)).json()) as { data: { title: string }[] }).data.map((post) => post.title)).toEqual(["From onStart"]);
  });

  const postgresUrl = process.env.TEST_POSTGRES_URL;
  (postgresUrl ? test : test.skip)("with two workers only worker 0 runs scheduled work", async () => {
    const worker = feature("probe", '  ctx.logger.info({ message: "setup probe", worker: ctx.worker });');
    const database = `postgresAdapter({ url: ${JSON.stringify(postgresUrl)} })`;
    for (const index of ["0", "1"]) {
      const started = await start({ "features/probe/index.ts": worker }, "probe: {}, server: { workers: 2 }", { QS_WORKER_INDEX: index }, database);
      expect(started.entries.find((item) => item.message === "setup probe")!.worker).toEqual({ index: Number(index), count: 2, runsScheduledWork: index === "0" });
      expect(await started.signal("SIGTERM")).toBe(0);
    }
  });
});

describe("failures and timeouts", () => {
  test("an onStart that throws stops the started features and exits with 1", async () => {
    const broken = feature("b", '  ctx.app.onStart(() => { throw new Error("no broker"); });\n  ctx.app.onStop(() => ctx.logger.info({ message: "stop b" }));', 'requires: ["a"],');
    const started = await start({ "features/a/index.ts": logging("a"), "features/b/index.ts": broken }, "a: {}, b: {}");
    expect(started.service).toBeUndefined();
    expect(started.exits).toEqual([1]);
    expect(started.events).toEqual(["setup a", "start a", "stop a"]);
    expect(started.entries.find((entry) => entry.message === "feature.failed")).toMatchObject({ feature: "b", phase: "onStart", error: { message: "no broker" } });
  });

  test("an onStart that never resolves fails after the start timeout, which the environment shortens", async () => {
    const hanging = feature("slow", "  ctx.app.onStart(() => new Promise(() => {}));");
    const begin = Date.now();
    const started = await start({ "features/slow/index.ts": hanging }, "slow: {}", { QS_LIFECYCLE_START_TIMEOUT: "1s" });
    expect(started.exits).toEqual([1]);
    expect(Date.now() - begin).toBeGreaterThanOrEqual(1000);
    expect(started.entries.find((entry) => entry.message === "feature.failed")).toMatchObject({ feature: "slow", phase: "onStart", error: { message: "slow onStart timed out after 1000 ms" } });
  });

  test("a setup that throws exits with 1 before connecting; an onStop that throws is logged and the exit is 0", async () => {
    const failing = feature("bad", '  throw new Error("missing key");');
    const started = await start({ "features/bad/index.ts": failing }, "bad: {}");
    expect(started.exits).toEqual([1]);
    expect(started.entries.find((entry) => entry.message === "feature.failed")).toMatchObject({ feature: "bad", phase: "setup" });

    const stopping = feature("flaky", '  ctx.app.onStop(() => { throw new Error("already closed"); });');
    const stopped = await start({ "features/flaky/index.ts": stopping }, "flaky: {}");
    expect(await stopped.signal("SIGTERM")).toBe(0);
    expect(stopped.entries.find((entry) => entry.message === "feature.failed")).toMatchObject({ feature: "flaky", phase: "onStop", error: { message: "already closed" } });
  });
});

describe("runtime routes", () => {
  test("routes registered in setup respond, with a trailing rest segment; route after setup throws", async () => {
    const routes = feature(
      "example",
      `  ctx.app.route("GET", "/example/status", () => ({ status: "ok" }));
  ctx.app.route("GET", "/assets/[...rest]", (_repos, req) => ({ rest: req.params.rest }));
  ctx.app.route("GET", "/teams/[team]/files/[...path]", (_repos, req) => ({ team: req.params.team, path: req.params.path }));
  ctx.app.onStart(() => {
    try {
      ctx.app.route("GET", "/late", () => 1);
    } catch (error) {
      ctx.logger.info({ message: "start example", error: (error as Error).message });
    }
  });`,
    );
    const started = await start({ "features/example/index.ts": routes }, "example: {}");
    expect(await (await fetch(`${started.url}/example/status`)).json()).toEqual({ status: "ok" });
    expect(await (await fetch(`${started.url}/assets/css/site.css`)).json()).toEqual({ rest: "css/site.css" });
    expect(await (await fetch(`${started.url}/teams/core/files/a/b%20c.txt`)).json()).toEqual({ team: "core", path: "a/b c.txt" });
    expect((await fetch(`${started.url}/assets`)).status).toBe(404);
    expect((await fetch(`${started.url}/assets/x`, { method: "POST" })).status).toBe(405);
    expect(started.entries.find((entry) => entry.message === "start example")!.error).toBe("ctx.app.route of example is only available during setup");
  });

  test("an endpoint wins over a runtime route with an info entry; duplicate or docs routes fail startup", async () => {
    const status = feature("example", '  ctx.app.route("GET", "/example/status", () => ({ from: "feature" }));');
    const started = await start({ "features/example/index.ts": status, "endpoints/example/status/get.ts": 'export default () => ({ from: "endpoint" });\n' }, "example: {}");
    expect(await (await fetch(`${started.url}/example/status`)).json()).toEqual({ from: "endpoint" });
    expect(started.entries.find((entry) => entry.message === "route.replaced")).toMatchObject({ route: "GET /example/status", feature: "example", replacedBy: "endpoint GET /example/status" });

    const twice = await start({ "features/example/index.ts": status, "features/other/index.ts": status.replace('key: "example"', 'key: "other"') }, "example: {}, other: {}");
    expect(twice.exits).toEqual([1]);
    expect((twice.entries.find((entry) => entry.message === "service.failed")!.error as { message: string }).message).toBe(
      "Runtime route GET /example/status is registered by both example and other",
    );
    const docs = await start({ "features/example/index.ts": feature("example", '  ctx.app.route("GET", "/docs", () => 1);') }, "example: {}");
    expect((docs.entries.find((entry) => entry.message === "service.failed")!.error as { message: string }).message).toBe(
      "Runtime route GET /docs of example takes a path reserved for the API docs",
    );
  });
});
