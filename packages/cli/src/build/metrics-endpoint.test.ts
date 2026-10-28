import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setMetricsClock } from "@quickservicets/core";
import { startTestService, type TestService } from "../testing/service.ts";
import { fakeClock } from "../../../core/src/jobs/test-support.ts";
import { prometheusText } from "../../../core/src/features/metrics/prometheus.ts";
import { queryWindows } from "../../../core/src/features/metrics/query.ts";
import { UsageRecorder } from "../../../core/src/features/metrics/windows.ts";

const CONFIG = (extra: string) => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({
  database: memoryAdapter(),
  logger: { info() {}, warn() {}, error() {} },
  ${extra}
});
`;
const FILES = {
  "endpoints/posts/get.ts": `import type { Repositories, ServiceRequest } from "@quickservicets/core";
export default (_repos: Repositories, req: ServiceRequest) => { if (req.query.get("fail")) throw new Error("boom"); return []; };
`,
  "endpoints/posts/post.ts": `import { HttpError, type Repositories, type ServiceRequest } from "@quickservicets/core";
export default (_repos: Repositories, req: ServiceRequest) => { if (req.query.get("bad")) throw new HttpError(400, "Bad"); return {}; };
`,
};
const LOCAL = { peer: "127.0.0.1" };

const running: TestService[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
  setMetricsClock(undefined);
});

async function start(extra: string, options: { auth?: boolean; env?: Record<string, string> } = {}) {
  const clock = fakeClock(Date.parse("2026-10-28T10:00:05.000Z"));
  setMetricsClock(clock);
  const { testAuth } = await import("@quickservicets/core/testing");
  const service = await startTestService({ files: { "quickservicets.config.ts": CONFIG(extra), ...FILES }, ...(options.auth ? { auth: testAuth() } : {}), ...(options.env ? { env: options.env } : {}) });
  running.push(service);
  return { service, clock };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The requests of the usage example: 10 GET /posts (2 failing) and 3 POST /posts (1 refused). */
async function traffic(service: TestService) {
  for (let i = 0; i < 10; i++) await service.fetch(i < 2 ? "/posts?fail=1" : "/posts");
  for (let i = 0; i < 3; i++) await service.fetch(i === 0 ? "/posts?bad=1" : "/posts", { method: "POST" });
  await settle();
}

/** A strict reader of the text exposition format 0.0.4: comments, then `name{labels} value` samples. */
function parseExposition(text: string) {
  const samples: { name: string; labels: Record<string, string>; value: number }[] = [];
  const types = new Map<string, string>();
  for (const line of text.trimEnd().split("\n")) {
    const type = /^# TYPE ([a-zA-Z_:][a-zA-Z0-9_:]*) (counter|gauge|histogram|summary|untyped)$/.exec(line);
    if (type) {
      types.set(type[1]!, type[2]!);
      continue;
    }
    if (/^# HELP [a-zA-Z_:][a-zA-Z0-9_:]* .+$/.test(line)) continue;
    const sample = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})? (-?[0-9.e+-]+|\+Inf|NaN)$/.exec(line);
    if (!sample) throw new Error(`Invalid exposition line: ${line}`);
    const labels: Record<string, string> = {};
    for (const match of (sample[3] ?? "").matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) labels[match[1]!] = match[2]!.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    const family = sample[1]!.replace(/_(bucket|sum|count)$/, "");
    if (!types.has(sample[1]!) && !types.has(family)) throw new Error(`Sample without a TYPE line: ${line}`);
    samples.push({ name: sample[1]!, labels, value: Number(sample[4]) });
  }
  return samples;
}

describe("route registration and exemptions", () => {
  test("ten scrapes without a tenant or user answer 200 under tenancy, required auth and a 1/min rate limit, and the route is not in the API docs", async () => {
    const { service } = await start(`metrics: {}, tenancy: {}, auth: { required: true }, security: { rateLimit: { limit: "1/min" } },`, { auth: true });
    for (let i = 0; i < 10; i++) expect((await service.fetch("/_metrics", LOCAL)).status).toBe(200);
    const openapi = (await (await service.fetch("/openapi.json", LOCAL)).json()) as { paths: Record<string, unknown> };
    expect(Object.keys(openapi.paths)).not.toContain("/_metrics");
  });
});

describe("the JSON form", () => {
  test("answers the series and totals, filters, sorts and limits, and names a bad parameter", async () => {
    const { service } = await start(`metrics: {}, tenancy: { source: "config", required: false, tenants: { acme: {} } },`);
    await traffic(service);
    await service.fetch("/posts", { headers: { "x-tenant-id": "acme" } });
    await settle();
    const body = (await (await service.fetch("/_metrics", LOCAL)).json()) as { window: string; totals: Record<string, number>; series: Record<string, unknown>[] };
    expect(body.window).toBe("1m");
    expect(body.totals).toMatchObject({ requests: 14, errors: 2, clientErrors: 1 });
    const get = body.series.find((series) => series.route === "GET /posts" && series.tenant === "-")!;
    expect(get).toMatchObject({ requests: 10, errors: 2, clientErrors: 0, errorRate: 0.2 });
    expect(Object.keys(get)).toEqual(["route", "tenant", "requests", "errors", "clientErrors", "errorRate", "p50", "p95", "p99", "max"]);
    expect(Number.isInteger((get.p95 as number) * 100)).toBe(true);

    const acme = (await (await service.fetch("/_metrics?last=5m&sort=p95&limit=1&tenant=acme", LOCAL)).json()) as { series: { tenant: string }[] };
    expect(acme.series).toEqual([expect.objectContaining({ tenant: "acme", requests: 1 })]);
    for (const [query, name] of [["last=1y", "last"], ["sort=size", "sort"], ["limit=5000", "limit"], ["by=planet", "by"], ["from=yesterday", "from"]] as const) {
      const response = await service.fetch(`/_metrics?${query}`, LOCAL);
      expect(response.status).toBe(400);
      const error = ((await response.json()) as { error: { code: string; message: string } }).error;
      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.message).toContain(name);
    }
  });
});

describe("the Prometheus form", () => {
  test("format=prometheus and Accept: text/plain answer the exposition, with cumulative counters that outlive the windows", async () => {
    const { service, clock } = await start(`metrics: { by: ["route"] },`);
    await traffic(service);
    for (const init of [{ path: "/_metrics?format=prometheus" }, { path: "/_metrics", headers: { accept: "text/plain;version=0.0.4" } }, { path: "/_metrics", headers: { accept: "application/openmetrics-text; version=1.0.0, text/plain;q=0.5" } }]) {
      const response = await service.fetch(init.path, { ...LOCAL, ...(init.headers ? { headers: init.headers } : {}) });
      expect(response.headers.get("content-type")).toStartWith("text/plain; version=0.0.4");
      const text = await response.text();
      expect(text).toContain('quickservicets_http_requests_total{method="GET",route="/posts",status_class="5xx"} 2');
      const samples = parseExposition(text);
      const buckets = samples.filter((sample) => sample.name === "quickservicets_http_request_duration_seconds_bucket" && sample.labels.method === "GET");
      expect(buckets.at(-1)!.labels.le).toBe("+Inf");
      expect(buckets.at(-1)!.value).toBe(10);
      expect(buckets.map((sample) => sample.value)).toEqual([...buckets.map((sample) => sample.value)].sort((a, b) => a - b));
    }
    expect((await service.fetch("/_metrics", { ...LOCAL, headers: { accept: "application/json" } })).headers.get("content-type")).toContain("application/json");

    for (let minute = 0; minute < 180; minute++) await clock.advance(60_000);
    await service.fetch("/posts");
    await settle();
    const later = await (await service.fetch("/_metrics?format=prometheus", LOCAL)).text();
    expect(later).toContain('quickservicets_http_requests_total{method="GET",route="/posts",status_class="2xx"} 9');
    expect((await (await service.fetch("/_metrics?last=15m", LOCAL)).json() as { totals: { requests: number } }).totals.requests).toBe(1);
  });

  test("label values are escaped, the tenant label follows by, and several workers add worker", () => {
    const usage = new UsageRecorder({ windowMs: 60_000, retentionMs: 7_200_000, rollupMs: 3_600_000, rollupRetentionMs: 86_400_000, by: ["route", "tenant"], maxSeries: 10, onOverflow: () => {} }, 0);
    usage.record({ method: "GET", route: '/a"b\\c', status: 200, durationMs: 3, tenantId: "acme" });
    const text = prometheusText([...usage.current.series.values()], { tenant: true, worker: 1 });
    expect(text).toContain('quickservicets_http_requests_total{method="GET",route="/a\\"b\\\\c",status_class="2xx",tenant="acme",worker="1"} 1');
    expect(parseExposition(text).every((sample) => sample.labels.worker === "1" && sample.labels.tenant === "acme")).toBe(true);
    expect(prometheusText([...usage.current.series.values()], { tenant: false })).not.toContain("tenant=");
  });
});

describe("access", () => {
  test("public peers get 403, a token is required when set, and an empty allow list takes any address with the token", async () => {
    const open = await start("metrics: {},");
    const refused = await open.service.fetch("/_metrics", { peer: "203.0.113.5" });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string; message: string } }).error).toEqual({ code: "FORBIDDEN", message: "Metrics are not available from this address" });
    expect((await open.service.fetch("/_metrics", { peer: "10.1.2.3" })).status).toBe(200);
    await open.service.stop();
    running.length = 0;

    const withToken = await start(`metrics: { access: { token: "s3cret-token" } },`);
    const anonymous = await withToken.service.fetch("/_metrics", { peer: "10.1.2.3" });
    expect(anonymous.status).toBe(401);
    expect(((await anonymous.json()) as { error: { message: string } }).error.message).toBe("Authentication required");
    expect((await withToken.service.fetch("/_metrics", { peer: "10.1.2.3", headers: { authorization: "Bearer wrong-token1" } })).status).toBe(401);
    expect((await withToken.service.fetch("/_metrics", { peer: "10.1.2.3", headers: { authorization: "Bearer s3cret-token" } })).status).toBe(200);
    await withToken.service.stop();
    running.length = 0;

    const anywhere = await start(`metrics: { access: { allow: [], token: "s3cret-token" } },`);
    expect((await anywhere.service.fetch("/_metrics", { peer: "203.0.113.5", headers: { authorization: "Bearer s3cret-token" } })).status).toBe(200);
    expect((await anywhere.service.fetch("/_metrics", { peer: "203.0.113.5" })).status).toBe(401);
  });
});

describe("chunked building", () => {
  test("a query over 20000 series yields to the event loop at least 20 times", async () => {
    const usage = new UsageRecorder({ windowMs: 60_000, retentionMs: 7_200_000, rollupMs: 3_600_000, rollupRetentionMs: 86_400_000, by: ["route", "tenant"], maxSeries: 100_000, onOverflow: () => {} }, 0);
    for (let i = 0; i < 20_000; i++) usage.record({ method: "GET", route: `/r${i}`, status: 200, durationMs: 1 });
    const yields = spyOn(globalThis, "setImmediate");
    try {
      const result = await queryWindows(usage.windows(), usage.settings, { from: 0, to: 60_000, limit: 1000 }, 1000);
      expect(result.totals.requests).toBe(20_000);
      expect(yields.mock.calls.length).toBeGreaterThanOrEqual(20);
    } finally {
      yields.mockRestore();
    }
  });
});
