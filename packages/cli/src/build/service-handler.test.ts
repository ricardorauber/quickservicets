import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createServiceHandler, memoryAdapter, startService, type DatabaseAdapter, type LogEntry, type ServiceConfig, type StartServiceOptions } from "@quickservicets/core";
import { createLinkedProject } from "../testing/project.ts";
import { build } from "./build.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Builds a project and returns the inputs its generated server passes to startService. */
async function generated(files: Record<string, string>): Promise<Omit<StartServiceOptions, "projectConfig">> {
  const root = createLinkedProject({
    "quickservicets.config.ts": 'import { defineConfig } from "@quickservicets/core";\nexport default defineConfig({});\n',
    "entities/Post.ts": "export type Post = { title: string };\n",
    ...files,
  });
  roots.push(root);
  await build(root, {});
  const dir = join(root, ".generated");
  const { models } = await import(join(dir, "models.ts"));
  const { crudRoutes, endpoints, hooks } = await import(join(dir, "routes.ts"));
  const { jobs } = await import(join(dir, "jobs.ts"));
  const { features, featureFolders } = await import(join(dir, "features.ts"));
  const openApi = await Bun.file(join(dir, "openapi.json")).json();
  return { models, crudRoutes, endpoints, hooks, jobs, features, featureFolders, openApi, generatedDir: dir, env: {} };
}

/** A logger keeping its entries. */
const recorder = () => {
  const entries: LogEntry[] = [];
  return { entries, logger: { info: (entry: LogEntry) => void entries.push(entry), warn: (entry: LogEntry) => void entries.push(entry), error: (entry: LogEntry) => void entries.push(entry) } };
};

/** A memory adapter counting its connections. */
const countingAdapter = () => {
  const inner = memoryAdapter();
  const counts = { connect: 0 };
  const adapter = new Proxy(inner, {
    get(target, name, receiver) {
      if (name === "connect") return (...args: unknown[]) => (counts.connect++, (target.connect as (...a: unknown[]) => Promise<void>)(...args));
      return Reflect.get(target, name, receiver);
    },
  }) as DatabaseAdapter;
  return { adapter, counts };
};

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("lazy, single-flight initialization", () => {
  test("creating a handler connects nothing, and two concurrent first requests initialize once", async () => {
    const inputs = await generated({});
    const { adapter, counts } = countingAdapter();
    const handler = createServiceHandler({ ...inputs, projectConfig: { database: adapter, logger: recorder().logger } as ServiceConfig, handleSigterm: false });
    expect(counts.connect).toBe(0);
    const [first, second] = await Promise.all([handler.fetch(new Request("http://x/posts")), handler.fetch(new Request("http://x/posts"))]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(counts.connect).toBe(1);
    await handler.stop();
  });
});

describe("pipeline parity", () => {
  test("startService answers like the handler, both on the shared pipeline", async () => {
    const inputs = await generated({ "endpoints/hello/get.ts": "export default () => ({ hello: true });\n" });
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = listener.port;
    listener.stop(true);
    const exits: number[] = [];
    const running = (await startService({ ...inputs, projectConfig: { database: memoryAdapter(), logger: recorder().logger, server: { port } } as ServiceConfig, process: { on() {}, once() {}, exit: (code: number) => void exits.push(code) } as never }))!;
    const handler = createServiceHandler({ ...inputs, projectConfig: { database: memoryAdapter(), logger: recorder().logger } as ServiceConfig, handleSigterm: false });
    try {
      const answers = async (send: (path: string, init?: RequestInit) => Promise<Response>) => {
        const created = await send("/posts", json({ title: "Same" }));
        const invalid = await send("/posts", json({ title: 1 }));
        const missing = await send("/nowhere");
        const hello = await send("/hello");
        return [created.status, invalid.status, ((await invalid.json()) as { error: { code: string } }).error.code, missing.status, await hello.json()];
      };
      const server = await answers((path, init) => fetch(`http://localhost:${running.port}${path}`, init));
      const platform = await answers((path, init) => handler.fetch(new Request(`http://x${path}`, init), { name: "test" }));
      expect(platform).toEqual(server);
      expect(server).toEqual([201, 400, "VALIDATION_ERROR", 404, { hello: true }]);
    } finally {
      await running.stop();
      await handler.stop();
    }
    expect(exits).toEqual([]);
  });
});

describe("platform data", () => {
  test("the platform's request id, client address and name reach the request", async () => {
    const inputs = await generated({ "endpoints/who/get.ts": 'import type { ServiceRequest } from "@quickservicets/core";\nexport default (_repos: unknown, req: ServiceRequest) => ({ id: req.id, ip: req.ip, platform: req.platform?.name, left: req.platform?.remainingMs() });\n' });
    const { entries, logger } = recorder();
    const handler = createServiceHandler({ ...inputs, projectConfig: { database: memoryAdapter(), logger } as ServiceConfig, handleSigterm: false });
    try {
      const response = await handler.fetch(new Request("http://x/who"), { name: "test", requestId: "abc", clientIp: "203.0.113.9" });
      expect(await response.json()).toEqual({ id: "abc", ip: "203.0.113.9", platform: "test", left: null });
      expect(entries.find((entry) => entry.route === "/who")).toMatchObject({ requestId: "abc", status: 200 });
      // A request that brings its own id keeps it.
      const own = await handler.fetch(new Request("http://x/who", { headers: { "x-request-id": "mine" } }), { name: "test", requestId: "abc" });
      expect(((await own.json()) as { id: string }).id).toBe("mine");
      // Without platform data the request has no req.platform.
      expect(((await (await handler.fetch(new Request("http://x/who"))).json()) as { platform?: string }).platform).toBeUndefined();
    } finally {
      await handler.stop();
    }
  });
});

describe("deadlines and initialization failures", () => {
  test("a handler still running at the deadline answers 504, and its signal aborted 500 ms before", async () => {
    const inputs = await generated({
      "endpoints/slow/get.ts": `import type { ServiceRequest } from "@quickservicets/core";
export const seen: { abortedAfter?: number } = {};
export default async (_repos: unknown, req: ServiceRequest) => {
  const started = Date.now();
  req.raw.signal.addEventListener("abort", () => (seen.abortedAfter = Date.now() - started));
  await Bun.sleep(1500);
  return { done: true };
};
`,
    });
    const handler = createServiceHandler({ ...inputs, projectConfig: { database: memoryAdapter(), logger: recorder().logger } as ServiceConfig, handleSigterm: false });
    try {
      await handler.init();
      const started = Date.now();
      const response = await handler.fetch(new Request("http://x/slow"), { name: "test", deadline: Date.now() + 1000 });
      const elapsed = Date.now() - started;
      expect(response.status).toBe(504);
      expect(await response.json()).toEqual({ error: { code: "GATEWAY_TIMEOUT", message: "Request exceeded the platform deadline" } });
      expect(elapsed).toBeGreaterThanOrEqual(950);
      expect(elapsed).toBeLessThan(1400);
      const { seen } = (await import(join(inputs.generatedDir!, "../endpoints/slow/get.ts"))) as { seen: { abortedAfter?: number } };
      expect(seen.abortedAfter).toBeGreaterThanOrEqual(450);
      expect(seen.abortedAfter).toBeLessThan(800);
    } finally {
      await handler.stop();
    }
  });

  test("a setup that throws once rejects the first request with service.init.failed, and the next one initializes", async () => {
    const inputs = await generated({
      "features/flaky/index.ts": `import { defineFeature } from "@quickservicets/core";
let calls = 0;
export default defineFeature({ key: "flaky", enabledByDefault: true, setup() { if (++calls === 1) throw new Error("not yet"); } });
`,
    });
    const { entries, logger } = recorder();
    const handler = createServiceHandler({ ...inputs, projectConfig: { database: memoryAdapter(), logger } as ServiceConfig, handleSigterm: false });
    try {
      await expect(handler.fetch(new Request("http://x/posts"))).rejects.toThrow("not yet");
      expect(entries.filter((entry) => entry.message === "service.init.failed")).toEqual([expect.objectContaining({ feature: "flaky", phase: "setup", error: expect.objectContaining({ message: "not yet" }) })]);
      expect((await handler.fetch(new Request("http://x/posts"))).status).toBe(200);
    } finally {
      await handler.stop();
    }
  });
});

describe("jobs and stop", () => {
  test("runJob records a completed run, an unknown job rejects, and stop runs the onStop callbacks", async () => {
    const inputs = await generated({
      "jobs/reports/daily.ts": 'import { job } from "@quickservicets/core";\nexport default job("0 6 * * *", async () => 42);\n',
      "features/closing/index.ts": `import { defineFeature } from "@quickservicets/core";
export const events: string[] = [];
export default defineFeature({ key: "closing", enabledByDefault: true, setup(ctx) { ctx.app.onShutdown(() => void events.push("shutdown")); ctx.app.onStop(() => void events.push("stop")); } });
`,
    });
    const handler = createServiceHandler({ ...inputs, projectConfig: { database: memoryAdapter(), logger: recorder().logger } as ServiceConfig, handleSigterm: false });
    const run = await handler.runJob("reports/daily");
    expect(run).toMatchObject({ job: "reports/daily", status: "success", result: 42 });
    expect((await handler.runJob("reports/daily"))?.status).toBe("success");
    await expect(handler.runJob("nope")).rejects.toThrow("Unknown job nope");
    await handler.stop();
    const { events } = (await import(join(inputs.generatedDir!, "../features/closing/index.ts"))) as { events: string[] };
    expect(events).toEqual(["shutdown", "stop"]);
  });

  test("SIGTERM stops the instance when the platform delivers one", async () => {
    const inputs = await generated({
      "features/closing/index.ts": `import { defineFeature } from "@quickservicets/core";
export const events: string[] = [];
export default defineFeature({ key: "closing", enabledByDefault: true, setup(ctx) { ctx.app.onStop(() => void events.push("stop")); } });
`,
    });
    const handler = createServiceHandler({ ...inputs, projectConfig: { database: memoryAdapter(), logger: recorder().logger } as ServiceConfig });
    await handler.init();
    const listeners = process.listeners("SIGTERM");
    const ours = listeners.at(-1)!;
    (ours as () => void)();
    await handler.stop();
    const { events } = (await import(join(inputs.generatedDir!, "../features/closing/index.ts"))) as { events: string[] };
    expect(events).toEqual(["stop"]);
    expect(process.listeners("SIGTERM")).not.toContain(ours);
  });
});
