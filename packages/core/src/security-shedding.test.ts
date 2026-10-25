import { afterEach, describe, expect, jest, test } from "bun:test";
import { memoryAdapter } from "./adapters/memory.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { createServer, type Route } from "./http/server.ts";
import { createFeatureLifecycle } from "./lifecycle.ts";
import type { LogEntry } from "./logger.ts";
import { middlewareStages } from "./middleware.ts";
import { Exemptions } from "./features/security/exempt.ts";
import { securityMiddlewares } from "./features/security/pipeline.ts";
import { loadSheddingStep } from "./features/security/shedding.ts";
// Loading the core registers the natives it ships.
import "./index.ts";

const logs: LogEntry[] = [];
const logger = { info: (entry: LogEntry) => void logs.push(entry), warn: (entry: LogEntry) => void logs.push(entry), error: (entry: LogEntry) => void logs.push(entry) };
afterEach(() => {
  logs.length = 0;
  jest.useRealTimers();
});

/** A route whose handler waits until `open()` is called. */
function gated() {
  const waiting: (() => void)[] = [];
  const route: Route = { method: "GET", path: "/slow", handler: () => new Promise((resolve) => waiting.push(() => resolve({ ok: true }))) };
  return { route, open: () => waiting.splice(0).forEach((resume) => resume()), waiting };
}

function shedding(maxInFlight: number, exemptions = new Exemptions(), routes: Route[] = []) {
  const step = loadSheddingStep({ enabled: true, maxInFlight, retryAfter: "1s" }, logger);
  exemptions.close();
  const { request } = securityMiddlewares([step], exemptions, () => undefined);
  const server = createServer({ routes, repos: {}, config: { production: false, logger }, middleware: middlewareStages([{ owner: "security", middleware: request }]) });
  const call = (path: string, init?: RequestInit) => server.fetch(new Request(`http://localhost${path}`, init));
  return { step, call };
}

const ok: Route["handler"] = () => ({ ok: true });

describe("counting and refusals", () => {
  test("a request over the limit gets 503 with Retry-After, and later requests pass again", async () => {
    const slow = gated();
    const { step, call } = shedding(2, undefined, [slow.route, { method: "GET", path: "/fast", handler: ok }]);
    const first = call("/slow");
    const second = call("/slow");
    await Bun.sleep(1);
    expect(step.inFlight()).toBe(2);
    const refused = await call("/fast");
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("1");
    expect(await refused.json()).toEqual({ error: { code: "SERVICE_UNAVAILABLE", message: "Server is busy" } });
    expect(step.inFlight()).toBe(2);
    slow.open();
    await Promise.all([first, second]);
    expect((await call("/fast")).status).toBe(200);
    expect(step.inFlight()).toBe(0);
  });

  test("the environment sets the limit, and loadShedding: false never refuses", async () => {
    const stepsOf = async (config: Record<string, unknown>, env: Record<string, string> = {}) => {
      const resolved = resolveConfig({ database: memoryAdapter(), logger, ...config } as ServiceConfig, env);
      expect((resolved.features.find((feature) => feature.key === "security")!.options.loadShedding as { maxInFlight: number }).maxInFlight).toBe(env.QS_SECURITY_LOAD_SHEDDING_MAX_IN_FLIGHT ? 1 : 1000);
      const lifecycle = createFeatureLifecycle({ features: resolved.features, config: resolved, models: [], worker: { index: 0, count: 1, runsScheduledWork: true } });
      await lifecycle.setup();
      const slow = gated();
      const server = createServer({ routes: [slow.route, { method: "GET", path: "/fast", handler: ok }], repos: {}, config: { production: false, logger }, middleware: middlewareStages(lifecycle.middleware) });
      const pending = server.fetch(new Request("http://localhost/slow"));
      await Bun.sleep(1);
      const status = (await server.fetch(new Request("http://localhost/fast"))).status;
      slow.open();
      await pending;
      return status;
    };
    expect(await stepsOf({}, { QS_SECURITY_LOAD_SHEDDING_MAX_IN_FLIGHT: "1", QS_SECURITY_RATE_LIMIT_ENABLED: "false" })).toBe(503);
    expect(await stepsOf({ security: { loadShedding: false } })).toBe(200);
  });
});

describe("streaming responses and exemptions", () => {
  test("a download stops counting once its response started", async () => {
    let finish!: () => void;
    const download: Route = {
      method: "GET",
      path: "/download",
      handler: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("part"));
              finish = () => controller.close();
            },
          }),
        ),
    };
    const { step, call } = shedding(1, undefined, [download, { method: "GET", path: "/fast", handler: ok }]);
    const response = await call("/download");
    expect(response.status).toBe(200);
    expect(step.inFlight()).toBe(0);
    expect((await call("/fast")).status).toBe(200);
    finish();
    expect(await response.text()).toBe("part");
  });

  test("an exempted path is never refused nor counted", async () => {
    const slow = gated();
    const exemptions = new Exemptions();
    exemptions.add("/health/*", ["loadShedding"]);
    const { step, call } = shedding(1, exemptions, [slow.route, { method: "GET", path: "/health/live", handler: ok }]);
    const pending = call("/slow");
    await Bun.sleep(1);
    const health = await call("/health/live");
    expect(health.status).toBe(200);
    expect(step.inFlight()).toBe(1);
    slow.open();
    await pending;
  });
});

describe("log throttling and failures", () => {
  test("50 refusals within a second log one entry with their count", async () => {
    const slow = gated();
    const { call } = shedding(1, undefined, [slow.route, { method: "GET", path: "/fast", handler: ok }]);
    const pending = call("/slow");
    await Bun.sleep(1);
    jest.useFakeTimers();
    for (let index = 0; index < 50; index++) expect((await call("/fast")).status).toBe(503);
    expect(logs.filter((entry) => entry.message === "security.load-shed")).toEqual([]);
    jest.advanceTimersByTime(1000);
    expect(logs.filter((entry) => entry.message === "security.load-shed")).toEqual([expect.objectContaining({ refused: 50, maxInFlight: 1 })]);
    jest.useRealTimers();
    slow.open();
    await pending;
  });

  test("the counter is back to 0 after throwing handlers and requests aborted by the client", async () => {
    const throwing: Route = { method: "GET", path: "/fail", handler: () => Promise.reject(new Error("boom")) };
    const abortable: Route = {
      method: "GET",
      path: "/abortable",
      handler: (_repos, req) => new Promise((resolve) => req.raw.signal.addEventListener("abort", () => resolve(undefined))),
    };
    const { step, call } = shedding(1000, undefined, [throwing, abortable]);
    const failures = await Promise.all(Array.from({ length: 100 }, () => call("/fail")));
    expect(failures.every((response) => response.status === 500)).toBe(true);
    const controllers = Array.from({ length: 100 }, () => new AbortController());
    const aborted = controllers.map((controller) => call("/abortable", { signal: controller.signal }));
    await Bun.sleep(1);
    expect(step.inFlight()).toBe(100);
    for (const controller of controllers) controller.abort();
    await Promise.allSettled(aborted);
    expect(step.inFlight()).toBe(0);
  });
});
