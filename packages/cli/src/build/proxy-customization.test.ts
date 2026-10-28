import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { testAuth } from "@quickservicets/core/testing";
import { startTestService, type TestService } from "../testing/service.ts";

type Seen = { upstream: string; path: string; headers: Record<string, string> };
const seen: Seen[] = [];
let delayMs = 0;
const upstreams: ReturnType<typeof Bun.serve>[] = [];
/** A local upstream that records what it receives under its name. */
const serve = (name: string) =>
  Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      seen.push({ upstream: name, path: `${url.pathname}${url.search}`, headers: Object.fromEntries(request.headers) });
      if (delayMs > 0) await Bun.sleep(delayMs);
      return Response.json({ upstream: name, path: url.pathname });
    },
  });
let eu: ReturnType<typeof Bun.serve>;
let us: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  eu = serve("eu");
  us = serve("us");
  upstreams.push(eu, us);
});
afterAll(() => {
  for (const upstream of upstreams) upstream.stop(true);
});
const at = (server: ReturnType<typeof Bun.serve>) => `http://127.0.0.1:${server.port}`;

const CONFIG = (extra: string, head = "") => `import { defineConfig, HttpError, memoryAdapter } from "@quickservicets/core";
${head}
export default defineConfig({
  database: memoryAdapter(),
  logger: {
    info: (entry: object) => void ((globalThis as any).gatewayLogs ??= []).push(entry),
    warn: (entry: object) => void ((globalThis as any).gatewayLogs ??= []).push(entry),
    error: (entry: object) => void ((globalThis as any).gatewayLogs ??= []).push(entry),
  },
  ${extra}
});
`;
const logs = () => ((globalThis as { gatewayLogs?: Record<string, unknown>[] }).gatewayLogs ??= []);

const running: TestService[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
  seen.length = 0;
  delayMs = 0;
  logs().length = 0;
  delete (globalThis as { forwarded?: unknown }).forwarded;
  delete (globalThis as { proxyErrors?: unknown }).proxyErrors;
});

async function start(extra: string, options: { head?: string; env?: Record<string, string>; files?: Record<string, string>; auth?: boolean } = {}) {
  const service = await startTestService({
    files: { "quickservicets.config.ts": CONFIG(extra, options.head), ...options.files },
    ...(options.env ? { env: options.env } : {}),
    ...(options.auth ? { auth: testAuth() } : {}),
  });
  running.push(service);
  return service;
}

describe("variables per route", () => {
  test("QS_PROXY_ROUTES_<NAME>_TARGET points a route elsewhere, and QS_PROXY_ROUTES defines routes as JSON", async () => {
    const moved = await start(`proxy: { routes: { billing: { path: "/billing/*", target: "${at(eu)}" } } },`, { env: { QS_PROXY_ROUTES_BILLING_TARGET: at(us), QS_PROXY_ROUTES_BILLING_STRIP_PREFIX: "true" } });
    expect(await (await moved.fetch("/billing/x")).json()).toEqual({ upstream: "us", path: "/x" });
    await moved.stop();
    running.length = 0;

    const json = await start("proxy: {},", { env: { QS_PROXY_ROUTES: JSON.stringify({ x: { path: "/x/*", target: at(eu) } }) } });
    expect(await (await json.fetch("/x/y")).json()).toEqual({ upstream: "eu", path: "/x/y" });
  });
});

describe("target functions", () => {
  test("a target function routes by tenant among allowedTargets, refuses other origins, and needs allowedTargets", async () => {
    const tenancy = `tenancy: { source: "config", tenants: { acme: { attributes: { region: "eu" } }, globex: { attributes: { region: "us" } } } },`;
    const service = await start(
      `${tenancy} proxy: { routes: { orders: { path: "/orders/*", target: ({ tenant }) => (tenant?.attributes.region === "eu" ? "${at(eu)}" : tenant?.id === "globex" ? "${at(us)}" : "http://127.0.0.1:1"), allowedTargets: ["${at(eu)}", "${at(us)}"] } } },`,
    );
    expect(await (await service.fetch("/orders/1", { headers: { "x-tenant-id": "acme" } })).json()).toEqual({ upstream: "eu", path: "/orders/1" });
    expect(await (await service.fetch("/orders/1", { headers: { "x-tenant-id": "globex" } })).json()).toEqual({ upstream: "us", path: "/orders/1" });
    const refusedTenancy = `tenancy: { source: "config", tenants: { acme: { attributes: { region: "mars" } } } },`;
    await service.stop();
    running.length = 0;
    const other = await start(`${refusedTenancy} proxy: { routes: { orders: { path: "/orders/*", target: () => "http://127.0.0.1:1", allowedTargets: ["${at(eu)}"] } } },`);
    const refused = await other.fetch("/orders/1", { headers: { "x-tenant-id": "acme" } });
    expect(refused.status).toBe(502);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toBe("Upstream request failed");
    expect(logs().find((entry) => entry.message === "proxy.target.refused")).toMatchObject({ route: "orders", origin: "http://127.0.0.1:1" });
    await other.stop();
    running.length = 0;

    await expect(start(`proxy: { routes: { orders: { path: "/orders/*", target: () => "${at(eu)}" } } },`)).rejects.toThrow("Invalid proxy.routes.orders: a target function needs allowedTargets");
  });
});

describe("hooks", () => {
  test("beforeProxy adds a header or is refused for another origin, and onProxyError receives a timeout", async () => {
    const service = await start(
      `proxy: {
    beforeProxy: [({ upstream, req }) => { upstream.headers.set("x-gateway", "1"); if (req.path.endsWith("/elsewhere")) return { url: "http://127.0.0.1:1/x", headers: upstream.headers }; }],
    onProxyError: [({ error, route }) => void ((globalThis as any).proxyErrors ??= []).push({ route, code: (error as any).code })],
    routes: { billing: { path: "/billing/*", target: "${at(eu)}", timeout: "100ms" } },
  },`,
    );
    await service.fetch("/billing/x");
    expect(seen.at(-1)!.headers["x-gateway"]).toBe("1");
    expect((await service.fetch("/billing/elsewhere")).status).toBe(502);
    expect(logs().some((entry) => entry.message === "proxy.target.refused")).toBe(true);
    delayMs = 400;
    expect((await service.fetch("/billing/slow")).status).toBe(504);
    expect((globalThis as { proxyErrors?: unknown[] }).proxyErrors).toEqual([{ route: "billing", code: "TIMEOUT" }]);
  });
});

describe("proxyRequest and the forwarder", () => {
  test("a project endpoint wraps a route with proxyRequest, and a recording forwarder sees calls after 401 and 429", async () => {
    const wrapped = await start(`auth: {}, proxy: { routes: { orders: { path: "/orders/*", target: "${at(eu)}", auth: "required" } } },`, {
      auth: true,
      files: {
        "endpoints/orders/summary/get.ts": `import { proxyRequest, type Repositories, type ServiceRequest } from "@quickservicets/core";
export default async (_repos: Repositories, req: ServiceRequest) => {
  const response = await proxyRequest(req, "orders", { path: "/orders/summary-v2" });
  const answer = new Response(response.body, response);
  answer.headers.set("x-wrapped", "1");
  return answer;
};
`,
      },
    });
    const user = { headers: { "x-test-user": "u1" } };
    const summary = await wrapped.fetch("/orders/summary", user);
    expect(summary.headers.get("x-wrapped")).toBe("1");
    expect(await summary.json()).toEqual({ upstream: "eu", path: "/orders/summary-v2" });
    expect(await (await wrapped.fetch("/orders/1", user)).json()).toEqual({ upstream: "eu", path: "/orders/1" });
    expect((await wrapped.fetch("/orders/summary")).status).toBe(401);
    await wrapped.stop();
    running.length = 0;
    seen.length = 0;

    const head = `const forwarder = { async forward({ request, url, route }: { request: Request; url: string; route: string }) { ((globalThis as any).forwarded ??= []).push({ url, route, method: request.method, user: request.headers.get("x-user-id") }); return Response.json({ recorded: true }); } };`;
    const recorded = await start(`auth: {}, proxy: { forwarder, routes: { orders: { path: "/orders/*", target: "${at(eu)}", auth: "required", rateLimit: { limit: "1/min" } } } },`, { head, auth: true });
    expect((await recorded.fetch("/orders/1", { peer: "198.51.100.1" })).status).toBe(401);
    expect(await (await recorded.fetch("/orders/1", { ...user, peer: "198.51.100.2" })).json()).toEqual({ recorded: true });
    expect((await recorded.fetch("/orders/1", { ...user, peer: "198.51.100.2" })).status).toBe(429);
    expect((globalThis as { forwarded?: unknown[] }).forwarded).toEqual([{ url: `${at(eu)}/orders/1`, route: "orders", method: "GET", user: "u1" }]);
    expect(seen).toHaveLength(0);
    await recorded.stop();
    running.length = 0;

    await expect(start("proxy: { forwarder: { send() {} } },")).rejects.toThrow("Invalid proxy.forwarder: ");
  });
});
