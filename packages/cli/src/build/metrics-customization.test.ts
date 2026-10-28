import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setMetricsClock } from "@quickservicets/core";
import { startTestService, type TestService } from "../testing/service.ts";
import { fakeClock } from "../../../core/src/jobs/test-support.ts";

const CONFIG = (extra: string, head = "") => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
${head}
export default defineConfig({
  database: memoryAdapter(),
  logger: {
    info: (entry: object) => void ((globalThis as any).metricLogs ??= []).push(entry),
    warn: (entry: object) => void ((globalThis as any).metricLogs ??= []).push(entry),
    error: (entry: object) => void ((globalThis as any).metricLogs ??= []).push(entry),
  },
  ${extra}
});
`;
const logs = () => ((globalThis as { metricLogs?: Record<string, unknown>[] }).metricLogs ??= []);
const FILES = {
  "entities/Post.ts": "/** @metrics by=route */\nexport type Post = { title: string };\n",
  "endpoints/internal/ping/get.ts": "/** @metrics off */\nexport default () => ({ pong: true });\n",
  "endpoints/orders/get.ts": "export default () => [];\n",
  "endpoints/reports/daily/get.ts": "export default () => ({});\n",
  "endpoints/reports/weekly/get.ts": "export default () => ({});\n",
};
const LOCAL = { peer: "127.0.0.1" };

const running: TestService[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
  setMetricsClock(undefined);
  logs().length = 0;
  delete (globalThis as { closedWindows?: unknown }).closedWindows;
  delete (globalThis as { storedWindows?: unknown }).storedWindows;
});

async function start(extra: string, options: { head?: string; env?: Record<string, string>; files?: Record<string, string> } = {}) {
  const clock = fakeClock(Date.parse("2026-10-28T10:00:05.000Z"));
  setMetricsClock(clock);
  const service = await startTestService({ files: { "quickservicets.config.ts": CONFIG(extra, options.head), ...FILES, ...options.files }, ...(options.env ? { env: options.env } : {}) });
  running.push(service);
  return { service, clock };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
type Body = { totals: { requests: number }; series: { route?: string; tenant?: string; requests: number }[] };
const usage = async (service: TestService, query = "") => (await (await service.fetch(`/_metrics${query}`, LOCAL)).json()) as Body;

describe("variables and the tag", () => {
  test("QS_METRICS_BY drops the tenant, QS_METRICS_ACCESS_TOKEN requires it, @metrics off and by=route apply per route", async () => {
    const byRoute = await start(`metrics: {}, tenancy: { source: "config", required: false, tenants: { acme: {} } },`, { env: { QS_METRICS_BY: "route" } });
    await byRoute.service.fetch("/orders", { headers: { "x-tenant-id": "acme" } });
    await settle();
    expect((await usage(byRoute.service)).series).toEqual([expect.objectContaining({ route: "GET /orders", requests: 1 })]);
    expect((await usage(byRoute.service)).series[0]!.tenant).toBeUndefined();
    await byRoute.service.stop();
    running.length = 0;

    const tagged = await start(`metrics: {}, tenancy: { source: "config", required: false, tenants: { acme: {} } },`, { env: { QS_METRICS_ACCESS_TOKEN: "metrics-token" } });
    expect((await tagged.service.fetch("/_metrics", LOCAL)).status).toBe(401);
    const auth = { ...LOCAL, headers: { authorization: "Bearer metrics-token" } };
    await tagged.service.fetch("/internal/ping");
    await tagged.service.fetch("/posts", { headers: { "x-tenant-id": "acme" } });
    await tagged.service.fetch("/orders", { headers: { "x-tenant-id": "acme" } });
    await settle();
    const body = (await (await tagged.service.fetch("/_metrics", auth)).json()) as Body;
    expect(body.series.map((series) => series.route).sort()).toEqual(["GET /orders", "GET /posts"]);
    expect(body.series.find((series) => series.route === "GET /posts")!.tenant).toBeUndefined();
    expect(body.series.find((series) => series.route === "GET /orders")!.tenant).toBe("acme");
  });
});

describe("the record function and the hooks", () => {
  test("record skips synthetic requests, beforeRecord groups routes, and onWindowClosed runs once per closed window even after a failure", async () => {
    const { service, clock } = await start(
      `metrics: {
    record: ({ req }) => !req?.headers.has("x-synthetic"),
    beforeRecord: [(observation) => (observation?.route?.startsWith("/reports/") ? { ...observation, route: "/reports/*" } : observation)],
    onWindowClosed: [() => { throw new Error("push failed"); }, ({ windowStart, series }) => void ((globalThis as any).closedWindows ??= []).push({ windowStart, series })],
  },`,
    );
    await service.fetch("/orders", { headers: { "x-synthetic": "1" } });
    await service.fetch("/orders");
    await service.fetch("/reports/daily");
    await service.fetch("/reports/weekly");
    await settle();
    const body = await usage(service);
    expect(body.series.map((series) => [series.route, series.requests]).sort()).toEqual([["GET /orders", 1], ["GET /reports/*", 2]]);
    await clock.advance(60_000);
    await settle();
    await service.fetch("/orders");
    await settle();
    await clock.advance(60_000);
    await settle();
    const closed = (globalThis as { closedWindows?: { windowStart: Date; series: { route: string; requests: number }[] }[] }).closedWindows ?? [];
    expect(closed).toHaveLength(2);
    expect(closed[0]!.series.map((series) => series.route).sort()).toEqual(["GET /orders", "GET /reports/*"]);
    expect(logs().filter((entry) => entry.message === "feature.hook.failed" && entry.hook === "onWindowClosed")).toHaveLength(2);
    expect((await usage(service, "?last=5m")).totals.requests).toBe(4);
  });
});

describe("the route override and queryMetrics", () => {
  test("a project endpoints/_metrics/get.ts replaces the route and reads the windows with queryMetrics", async () => {
    const { service } = await start("metrics: {},", {
      files: { "endpoints/_metrics/get.ts": 'import { queryMetrics } from "@quickservicets/core";\nexport default async () => ({ custom: true, usage: await queryMetrics({ last: "1h" }) });\n' },
    });
    await service.fetch("/orders");
    await settle();
    const body = (await (await service.fetch("/_metrics", { peer: "203.0.113.9" })).json()) as { custom: boolean; usage: { totals: { requests: number } } };
    expect(body.custom).toBe(true);
    expect(body.usage.totals.requests).toBe(1);
  });
});

describe("the store provider and the reference page", () => {
  test("a store receives the closed windows and serves reads; one without prune fails; the reference lists the variables and the tag", async () => {
    const head = `const stored: any[] = ((globalThis as any).storedWindows = []);
const store = {
  async write(windows: any[]) { for (const window of windows) { const at = stored.findIndex((entry) => entry.instance === window.instance && entry.resolution === window.resolution && +entry.windowStart === +window.windowStart); if (at >= 0) stored[at] = window; else stored.push(window); } },
  async read({ from, to }: { from: Date; to: Date }) { return stored.filter((window) => window.windowStart >= from && window.windowStart < to); },
  async prune({ resolution, before }: { resolution: string; before: Date }) { const keep = stored.filter((window) => window.resolution !== resolution || window.windowStart >= before); const count = stored.length - keep.length; stored.splice(0, stored.length, ...keep); return count; },
};`;
    const { service, clock } = await start("metrics: { store },", { head });
    await service.fetch("/orders");
    await service.fetch("/orders");
    await settle();
    await clock.advance(60_000);
    await settle();
    const stored = (globalThis as { storedWindows?: { resolution: string; series: { requests: number }[] }[] }).storedWindows!;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.series[0]!.requests).toBe(2);
    await service.fetch("/orders");
    await settle();
    expect((await usage(service, "?last=5m")).totals.requests).toBe(3);
    await service.stop();
    running.length = 0;

    await expect(start("metrics: { store: { write() {}, read() {} } },")).rejects.toThrow("Invalid metrics.store: ");
    const reference = readFileSync(join(import.meta.dir, "../../../../docs/src/content/docs/reference/features/metrics.mdx"), "utf8");
    expect(reference).toContain("QS_METRICS_WINDOW");
    expect(reference).toContain("@metrics");
    expect(reference).toContain("MetricsStore");
    expect(reference).toContain("onWindowClosed");
  });
});
