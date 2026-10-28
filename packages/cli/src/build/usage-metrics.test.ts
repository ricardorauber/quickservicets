import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setMetricsClock, type MetricsApi } from "@quickservicets/core";
import { startTestService, type TestService } from "../testing/service.ts";
import { fakeClock } from "../../../core/src/jobs/test-support.ts";
import * as observers from "../../../core/src/request-observers.ts";

const CONFIG = (extra: string) => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({
  database: memoryAdapter(),
  logger: { info() {}, warn() {}, error() {} },
  ${extra}
});
`;
/** A project feature handing the metrics API to the test. */
const PROBE = `import { defineFeature } from "@quickservicets/core";
export default defineFeature({
  key: "probe",
  enabledByDefault: true,
  after: ["metrics"],
  setup(ctx) {
    if (ctx.config.features.some((feature) => feature.key === "metrics")) ctx.app.onStart(() => void ((globalThis as any).metricsApi = ctx.feature("metrics")));
  },
});
`;
const FILES = {
  "features/probe/index.ts": PROBE,
  "endpoints/posts/get.ts": `import type { Repositories, ServiceRequest } from "@quickservicets/core";
export default (_repos: Repositories, req: ServiceRequest) => { if (req.query.get("fail")) throw new Error("boom"); return []; };
`,
  "endpoints/posts/post.ts": `import { HttpError, type Repositories, type ServiceRequest } from "@quickservicets/core";
export default (_repos: Repositories, req: ServiceRequest) => { if (req.query.get("bad")) throw new HttpError(400, "Bad"); return {}; };
`,
  "endpoints/me/get.ts": "export default () => ({});\n",
};

const running: TestService[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
  setMetricsClock(undefined);
  delete (globalThis as { metricsApi?: unknown }).metricsApi;
});

async function start(extra: string, options: { auth?: boolean } = {}) {
  const clock = fakeClock(Date.parse("2026-10-28T10:00:05.000Z"));
  setMetricsClock(clock);
  const { testAuth } = await import("@quickservicets/core/testing");
  const service = await startTestService({ files: { "quickservicets.config.ts": CONFIG(extra), ...FILES }, ...(options.auth ? { auth: testAuth() } : {}) });
  running.push(service);
  return { service, clock, api: () => (globalThis as { metricsApi?: MetricsApi }).metricsApi! };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("usage metrics in a running service", () => {
  test("requests of one minute are counted per route with errors and client errors", async () => {
    const { service, api } = await start("metrics: {},");
    for (let i = 0; i < 10; i++) await service.fetch(i < 2 ? "/posts?fail=1" : "/posts");
    for (let i = 0; i < 3; i++) await service.fetch(i === 0 ? "/posts?bad=1" : "/posts", { method: "POST" });
    await settle();
    const result = await api().query({ last: "5m" });
    const byRoute = Object.fromEntries(result.series.map((series) => [series.route, series]));
    expect(byRoute["GET /posts"]).toMatchObject({ tenant: "-", requests: 10, errors: 2, clientErrors: 0 });
    expect(byRoute["POST /posts"]).toMatchObject({ requests: 3, errors: 0, clientErrors: 1 });
    expect(result.totals.requests).toBe(13);
    expect(byRoute["GET /posts"]!.p95).toBeGreaterThan(0);
  });

  test("tenants give separate series, and by user gives the user or -", async () => {
    const tenants = await start(`metrics: {}, tenancy: { source: "config", tenants: { acme: {}, globex: {} } },`);
    await tenants.service.fetch("/posts", { headers: { "x-tenant-id": "acme" } });
    await tenants.service.fetch("/posts", { headers: { "x-tenant-id": "globex" } });
    await settle();
    expect((await tenants.api().query()).series.map((series) => series.tenant).sort()).toEqual(["acme", "globex"]);
    await tenants.service.stop();
    running.length = 0;

    const users = await start(`auth: {}, metrics: { by: ["route", "user"] },`, { auth: true });
    await users.service.fetch("/me", { headers: { "x-test-user": "u1" } });
    await users.service.fetch("/me");
    await settle();
    expect((await users.api().query()).series.map((series) => series.user).sort()).toEqual(["-", "u1"]);
  });

  test("windows close on the clock, and the last three hours still count every request", async () => {
    const { service, clock, api } = await start("metrics: {},");
    for (let minute = 0; minute < 180; minute++) {
      await service.fetch("/posts");
      await settle();
      await clock.advance(60_000);
    }
    const result = await api().query({ last: "3h" });
    expect(result.totals.requests).toBe(180);
  });

  test("health routes are not counted, and without metrics no observer runs", async () => {
    const { service, api } = await start("metrics: {}, health: {},");
    await service.fetch("/health/live");
    await service.fetch("/posts");
    await settle();
    expect((await api().query()).totals.requests).toBe(1);
    await service.stop();
    running.length = 0;

    const notify = spyOn(observers, "notifyRequestObservers");
    try {
      const plain = await start("");
      await plain.service.fetch("/posts");
      expect(observers.requestsObserved()).toBe(false);
      expect(notify).not.toHaveBeenCalled();
    } finally {
      notify.mockRestore();
    }
  });
});
