import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { testAuth } from "@quickservicets/core/testing";
import { startTestService, type TestService } from "../testing/service.ts";

/** What the local upstreams saw of each request. */
type Seen = { upstream: string; method: string; path: string; headers: Record<string, string>; body: string };
const seen: Seen[] = [];
let delayMs = 0;
const upstreams: ReturnType<typeof Bun.serve>[] = [];
/** A local upstream that records what it receives under its name and answers JSON, or 404 under /missing. */
const serve = (name: string) =>
  Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 30,
    async fetch(request) {
      const url = new URL(request.url);
      const body = await request.text();
      seen.push({ upstream: name, method: request.method, path: `${url.pathname}${url.search}`, headers: Object.fromEntries(request.headers), body });
      if (delayMs > 0) await Bun.sleep(delayMs);
      const status = url.pathname.endsWith("/missing") ? 404 : 200;
      return Response.json({ upstream: name, path: url.pathname, secret: "internal", items: [1, 2] }, { status, headers: { "x-upstream": name } });
    },
  });
let catalog: ReturnType<typeof Bun.serve>;
let stock: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  catalog = serve("catalog");
  stock = serve("stock");
  upstreams.push(catalog, stock);
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
    info: (entry: object) => void ((globalThis as any).forwardLogs ??= []).push(entry),
    warn: (entry: object) => void ((globalThis as any).forwardLogs ??= []).push(entry),
    error: (entry: object) => void ((globalThis as any).forwardLogs ??= []).push(entry),
  },
  ${extra}
});
`;
const logs = () => ((globalThis as { forwardLogs?: Record<string, unknown>[] }).forwardLogs ??= []);
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** An endpoint file whose handler body receives `req` and `forward`. */
const endpoint = (body: string) => `import { forward, proxyRequest, HttpError, type Repositories, type ServiceRequest } from "@quickservicets/core";
export default async (_repos: Repositories, req: ServiceRequest) => {
  ${body}
};
`;

const running: TestService[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
  seen.length = 0;
  delayMs = 0;
  logs().length = 0;
  delete (globalThis as { forwarded?: unknown }).forwarded;
  delete (globalThis as { proxySteps?: unknown }).proxySteps;
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

/** Reads the error message of a JSON error answer. */
const message = async (response: Response) => ((await response.json()) as { error: { message: string } }).error.message;

describe("option shapes and paths", () => {
  test("an inline service with path, stripPrefix and rewrite builds the upstream path, keeps the query, and refuses two path rules or no upstream", async () => {
    const service = await start(`proxy: {}, http: { services: { catalog: { url: "${at(catalog)}" } } },`, {
      files: {
        "endpoints/products/get.ts": endpoint(`return forward(req, { service: "catalog", path: "/items" });`),
        "endpoints/own-query/get.ts": endpoint(`return forward(req, { service: "catalog", path: "/items?page=9" });`),
        "endpoints/dashboard/[page]/get.ts": endpoint(`return req.query.get("mode") === "rewrite" ? forward(req, { service: "catalog", rewrite: "/v2/[...rest]" }) : forward(req, { service: "catalog", stripPrefix: "/dashboard" });`),
        "endpoints/both/get.ts": endpoint(`try { forward(req, { service: "catalog", path: "/a", stripPrefix: "/both" }); } catch (error) { return { error: (error as Error).message }; }`),
        "endpoints/none/get.ts": endpoint(`try { forward(req, {} as never); } catch (error) { return { error: (error as Error).message }; }`),
        "endpoints/two/get.ts": endpoint(`try { forward(req, { service: "catalog", target: "http://x" } as never); } catch (error) { return { error: (error as Error).message }; }`),
      },
    });
    const products = await service.fetch("/products?page=2");
    expect(products.status).toBe(200);
    expect(products.headers.get("content-type")).toContain("application/json");
    expect(((await products.json()) as { path: string }).path).toBe("/items");
    expect(seen.at(-1)!.path).toBe("/items?page=2");
    await service.fetch("/own-query?page=2");
    expect(seen.at(-1)!.path).toBe("/items?page=9");
    await service.fetch("/dashboard/a?x=1");
    expect(seen.at(-1)!.path).toBe("/a?x=1");
    await service.fetch("/dashboard/a?mode=rewrite");
    expect(seen.at(-1)!.path).toBe("/v2/dashboard/a?mode=rewrite");
    expect(await (await service.fetch("/both")).json()).toEqual({ error: "forward(): use only one of path, stripPrefix or rewrite" });
    expect(await (await service.fetch("/none")).json()).toEqual({ error: "forward(): set service or target" });
    expect(await (await service.fetch("/two")).json()).toEqual({ error: "forward(): set service or target" });
  });

  test("the headers option adds headers but never hop-by-hop or identity headers", async () => {
    const service = await start(`proxy: { identity: { secret: "gateway-secret-1" } }, http: { services: { catalog: { url: "${at(catalog)}" } } },`, {
      files: {
        "endpoints/products/get.ts": endpoint(`return forward(req, { service: "catalog", headers: { "x-extra": "1", "x-user-id": "admin", "x-tenant-id": "t", "x-quickservicets-identity": "t=1,v1=00", connection: "x-extra", upgrade: "websocket" } });`),
      },
    });
    await service.fetch("/products");
    const headers = seen.at(-1)!.headers;
    expect(headers["x-extra"]).toBe("1");
    expect(headers["x-user-id"]).toBeUndefined();
    expect(headers["x-tenant-id"]).toBeUndefined();
    expect(headers.upgrade).toBeUndefined();
    expect(headers["x-quickservicets-identity"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });
});

describe("route names", () => {
  test("a route name checks the route's authentication first, applies overrides, times out with its override, and an unknown name throws", async () => {
    const service = await start(`auth: {}, proxy: { routes: { orders: { path: "/orders/*", target: "${at(catalog)}", auth: "required" } } },`, {
      auth: true,
      files: {
        "endpoints/summary/get.ts": endpoint(`return forward(req, "orders", { path: "/orders/summary-v2", headers: { "x-wrapped": "1" } });`),
        "endpoints/stripped/[page]/get.ts": endpoint(`return forward(req, "orders", { stripPrefix: "/stripped" });`),
        "endpoints/slow/get.ts": endpoint(`return forward(req, "orders", { timeout: "1s" });`),
        "endpoints/nope/get.ts": endpoint(`try { forward(req, "nope"); } catch (error) { return { error: (error as Error).message }; }`),
      },
    });
    const user = { headers: { "x-test-user": "u1" } };
    expect((await service.fetch("/summary")).status).toBe(401);
    expect(seen).toHaveLength(0);
    const summary = await service.fetch("/summary", user);
    expect(await summary.json()).toMatchObject({ path: "/orders/summary-v2" });
    expect(seen.at(-1)!.headers).toMatchObject({ "x-wrapped": "1", "x-user-id": "u1" });
    await service.fetch("/stripped/a", user);
    expect(seen.at(-1)!.path).toBe("/a");
    expect(await (await service.fetch("/nope", user)).json()).toEqual({ error: "Unknown proxy route nope" });

    // The upstream answers after three seconds; the override's one second answers 504 first.
    delayMs = 3000;
    const started = performance.now();
    const slow = await service.fetch("/slow", user);
    const elapsed = performance.now() - started;
    expect(slow.status).toBe(504);
    expect(await message(slow)).toBe("Upstream request timed out");
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(2800);
  });
});

describe("pipeline reuse", () => {
  test("a forward call carries the signed identity to proxyIdentity, runs beforeProxy with route null, and goes through the forwarder", async () => {
    const behind = await startTestService({
      files: {
        "quickservicets.config.ts": `import { defineConfig, memoryAdapter, proxyIdentity } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), logger: { info() {}, warn() {}, error() {} }, auth: { providers: [proxyIdentity({ secret: "gateway-secret-1" })] } });
`,
        "endpoints/me/get.ts": `import type { Repositories, ServiceRequest } from "@quickservicets/core";
export default (_repos: Repositories, req: ServiceRequest) => ({ user: req.user?.id ?? null, gateway: req.headers.get("x-gateway") });
`,
      },
    });
    running.push(behind);
    const behindUrl = (await behind.listen()).url;
    const gateway = await start(
      `auth: {}, http: { services: { accounts: { url: "${behindUrl}" } } }, proxy: {
    identity: { secret: "gateway-secret-1" },
    beforeProxy: [({ upstream, route }) => { ((globalThis as any).proxySteps ??= []).push({ route }); upstream.headers.set("x-gateway", "1"); }],
  },`,
      { auth: true, files: { "endpoints/account/get.ts": endpoint(`return forward(req, { service: "accounts", path: "/me" });`) } },
    );
    expect(await (await gateway.fetch("/account", { headers: { "x-test-user": "u7" } })).json()).toEqual({ user: "u7", gateway: "1" });
    expect((globalThis as { proxySteps?: unknown[] }).proxySteps).toEqual([{ route: null }]);
    await gateway.stop();
    running.splice(running.indexOf(gateway), 1);

    const head = `const forwarder = { async forward({ url, route, request }: { url: string; route: string | null; request: Request }) { ((globalThis as any).forwarded ??= []).push({ url, route, user: request.headers.get("x-user-id") }); return Response.json({ recorded: true }); } };`;
    const recorded = await start(`auth: {}, proxy: { forwarder, allowedTargets: ["${at(catalog)}"] },`, {
      head,
      auth: true,
      files: { "endpoints/account/get.ts": endpoint(`return forward(req, { target: "${at(catalog)}", path: "/me" });`) },
    });
    expect(await (await recorded.fetch("/account", { headers: { "x-test-user": "u7" } })).json()).toEqual({ recorded: true });
    expect((globalThis as { forwarded?: unknown[] }).forwarded).toEqual([{ url: `${at(catalog)}/me`, route: null, user: "u7" }]);
    expect(seen).toHaveLength(0);
  });
});

describe("responses and errors", () => {
  test("the caller reads and changes the upstream JSON, gets a 404 as a response, and an uncaught connection failure answers 502", async () => {
    const service = await start(`proxy: {}, http: { services: { catalog: { url: "${at(catalog)}" }, closed: { url: "http://127.0.0.1:1" } } },`, {
      files: {
        "endpoints/products/get.ts": endpoint(`const response = await forward(req, { service: "catalog", path: "/items" });
  const { secret: _secret, ...rest } = (await response.json()) as Record<string, unknown>;
  return { ...rest, status: response.status, header: response.headers.get("x-upstream") };`),
        "endpoints/missing/get.ts": endpoint(`const response = await forward(req, { service: "catalog", path: "/missing" });
  return { status: response.status, ok: response.ok };`),
        "endpoints/closed/get.ts": endpoint(`return forward(req, { service: "closed" });`),
        "endpoints/caught/get.ts": endpoint(`try { await forward(req, { service: "closed" }); } catch (error) { return { http: error instanceof HttpError, status: (error as HttpError).status }; }`),
      },
    });
    expect(await (await service.fetch("/products")).json()).toEqual({ upstream: "catalog", path: "/items", items: [1, 2], status: 200, header: "catalog" });
    expect(await (await service.fetch("/missing")).json()).toEqual({ status: 404, ok: false });
    const closed = await service.fetch("/closed");
    expect(closed.status).toBe(502);
    expect(await message(closed)).toBe("Upstream request failed");
    expect(await (await service.fetch("/caught")).json()).toEqual({ http: true, status: 502 });
  });
});

describe("allowed targets", () => {
  test("an inline target must be an allowed target, is trusted without http.allow, and an unknown service throws", async () => {
    const service = await start(`proxy: { allowedTargets: ["${at(catalog)}"] },`, {
      files: {
        "endpoints/allowed/get.ts": endpoint(`return forward(req, { target: "${at(catalog)}", path: "/items" });`),
        "endpoints/refused/get.ts": endpoint(`return forward(req, { target: "${at(stock)}", path: "/items" });`),
        "endpoints/unknown/get.ts": endpoint(`try { forward(req, { service: "ghost" }); } catch (error) { return { error: (error as Error).message }; }`),
      },
    });
    const allowed = await service.fetch("/allowed");
    expect(allowed.status).toBe(200);
    expect(seen.at(-1)!.upstream).toBe("catalog");
    const refused = await service.fetch("/refused");
    expect(refused.status).toBe(502);
    expect(await message(refused)).toBe("Upstream request failed");
    expect(logs().find((entry) => entry.message === "proxy.target.refused")).toMatchObject({ route: null, origin: at(stock) });
    expect(seen.filter((entry) => entry.upstream === "stock")).toHaveLength(0);
    expect(((await (await service.fetch("/unknown")).json()) as { error: string }).error).toStartWith("Unknown service ghost");
    await service.stop();
    running.length = 0;

    const fromEnv = await start("proxy: {},", {
      env: { QS_PROXY_ALLOWED_TARGETS: `${at(stock)},${at(catalog)}` },
      files: { "endpoints/stock/get.ts": endpoint(`return forward(req, { target: "${at(stock)}", path: "/items" });`) },
    });
    expect((await fromEnv.fetch("/stock")).status).toBe(200);
    expect(seen.at(-1)!.upstream).toBe("stock");
  });
});

describe("requirements, logging and the alias", () => {
  test("forward needs the proxy native, refuses a body already read, and proxy: {} starts without routes", async () => {
    const without = await start("", {
      files: { "endpoints/products/get.ts": endpoint(`try { forward(req, { service: "catalog" }); } catch (error) { return { error: (error as Error).message }; }`) },
    });
    expect(await (await without.fetch("/products")).json()).toEqual({ error: "forward() needs proxy: {} in quickservicets.config.ts" });
    await without.stop();
    running.length = 0;

    const service = await start(`proxy: {}, http: { services: { catalog: { url: "${at(catalog)}" } } },`, {
      files: {
        "endpoints/orders/post.ts": endpoint(`await req.json();
  try { forward(req, { service: "catalog" }); } catch (error) { return { error: (error as Error).message }; }`),
        "endpoints/streamed/post.ts": endpoint(`return forward(req, { service: "catalog", path: "/upload" });`),
      },
    });
    expect(await (await service.fetch("/orders", { method: "POST", body: JSON.stringify({ a: 1 }), headers: { "content-type": "application/json" } })).json()).toEqual({ error: "forward(): the request body was already read" });
    expect((await service.fetch("/streamed", { method: "POST", body: "hello", headers: { "content-type": "text/plain" } })).status).toBe(200);
    expect(seen.at(-1)).toMatchObject({ method: "POST", path: "/upload", body: "hello" });
    expect((await service.fetch("/anything")).status).toBe(404);
  });

  test("an inline target logs service proxy/forward and proxy forward; proxyRequest behaves like forward with a route name", async () => {
    const service = await start(`proxy: { allowedTargets: ["${at(catalog)}"], routes: { orders: { path: "/orders/*", target: "${at(stock)}" } } },`, {
      files: {
        "endpoints/inline/get.ts": endpoint(`const response = await forward(req, { target: "${at(catalog)}", path: "/items" });
  return { status: response.status };`),
        "endpoints/alias/get.ts": endpoint(`return proxyRequest(req, "orders", { path: "/orders/alias" });`),
        "endpoints/named/get.ts": endpoint(`return forward(req, "orders", { path: "/orders/alias" });`),
      },
    });
    await (await service.fetch("/inline")).json();
    await settle();
    expect(logs().find((entry) => entry.message === "http.call")).toMatchObject({ service: "proxy/forward", status: 200 });
    expect(logs().find((entry) => entry.route === "/inline" && entry.status === 200)).toMatchObject({ proxy: "forward" });
    logs().length = 0;
    const alias = await (await service.fetch("/alias")).json();
    const named = await (await service.fetch("/named")).json();
    expect(alias).toEqual(named);
    expect(alias).toMatchObject({ upstream: "stock", path: "/orders/alias" });
    await settle();
    expect(logs().filter((entry) => entry.message === "http.call").map((entry) => entry.service)).toEqual(["proxy/orders", "proxy/orders"]);
    expect(logs().filter((entry) => entry.route === "/alias" || entry.route === "/named").map((entry) => entry.proxy)).toEqual(["orders", "orders"]);
  });
});
