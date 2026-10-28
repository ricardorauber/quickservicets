import { afterEach, beforeAll, afterAll, describe, expect, test } from "bun:test";
import { mockHttp } from "@quickservicets/core/testing";
import { startTestService, type TestService } from "../testing/service.ts";

/** What the local upstream saw of each request. */
type Seen = { method: string; path: string; headers: Record<string, string>; bytes: number };
const seen: Seen[] = [];
let delayMs = 0;
let upstream: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 60,
    async fetch(request) {
      const url = new URL(request.url);
      let bytes = 0;
      if (request.body) for await (const chunk of request.body) bytes += chunk.byteLength;
      seen.push({ method: request.method, path: `${url.pathname}${url.search}`, headers: Object.fromEntries(request.headers), bytes });
      if (delayMs > 0) await Bun.sleep(delayMs);
      if (url.pathname.endsWith("/download")) {
        let sent = 0;
        const chunk = new Uint8Array(1 << 16);
        return new Response(new ReadableStream({ pull(controller) { if (sent >= 800) return controller.close(); sent += 1; controller.enqueue(chunk); } }), { headers: { "content-type": "application/octet-stream" } });
      }
      return Response.json({ path: url.pathname, received: bytes }, { status: url.pathname.endsWith("/missing") ? 404 : 200, headers: { "x-upstream": "1", connection: "keep-alive, x-hop", "x-hop": "secret", "keep-alive": "timeout=5" } });
    },
  });
});
afterAll(() => upstream.stop(true));

const CONFIG = (extra: string) => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({
  database: memoryAdapter(),
  logger: {
    info: (entry: object) => void ((globalThis as any).proxyLogs ??= []).push(entry),
    warn: (entry: object) => void ((globalThis as any).proxyLogs ??= []).push(entry),
    error: (entry: object) => void ((globalThis as any).proxyLogs ??= []).push(entry),
  },
  ${extra}
});
`;
const logs = () => ((globalThis as { proxyLogs?: Record<string, unknown>[] }).proxyLogs ??= []);
const target = () => `http://127.0.0.1:${upstream.port}`;

const running: TestService[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
  seen.length = 0;
  delayMs = 0;
  logs().length = 0;
});

async function start(extra: string, files: Record<string, string> = {}) {
  const service = await startTestService({ files: { "quickservicets.config.ts": CONFIG(extra), "entities/Post.ts": "export type Post = { title: string };\n", ...files } });
  running.push(service);
  return service;
}

const billing = (extra = "") => `proxy: { routes: { billing: { path: "/billing/*", target: "${target()}"${extra} } } },`;
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("route options and checks", () => {
  test("target and service together fail, overlapping routes fail naming both", async () => {
    await expect(start(`proxy: { routes: { billing: { path: "/billing/*", target: "http://127.0.0.1:1", service: "billing" } } }, http: { services: { billing: { url: "http://127.0.0.1:1" } } },`)).rejects.toThrow("Invalid proxy.routes.billing: set target or service");
    await expect(start(`proxy: { routes: { billing: { path: "/billing/*" } } },`)).rejects.toThrow("Invalid proxy.routes.billing: set target or service");
    await expect(start(`proxy: { routes: { billing: { path: "/billing/*", target: "http://127.0.0.1:1" }, invoices: { path: "/billing/invoices", target: "http://127.0.0.1:2" } } },`)).rejects.toThrow("Proxy routes billing (/billing/*) and invoices (/billing/invoices) overlap");
  });
});

describe("runtime routes", () => {
  test("a configured route forwards without an http.allow entry, and a project endpoint under its prefix wins", async () => {
    const service = await start(billing(), { "endpoints/billing/health/get.ts": "export default () => ({ local: true });\n" });
    const response = await service.fetch("/billing/invoices?page=2");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ path: "/billing/invoices", received: 0 });
    expect(seen[0]!.path).toBe("/billing/invoices?page=2");
    const missing = await service.fetch("/billing/missing");
    expect(missing.status).toBe(404);
    expect(await (await service.fetch("/billing/health")).json()).toEqual({ local: true });
    expect(seen).toHaveLength(2);
    expect((await service.fetch("/posts")).status).toBe(200);
  });
});

describe("streaming and headers", () => {
  test("50 MB go up and come back streamed, with memory growth under 10 MB", async () => {
    const service = await start(`${billing()} security: { limits: { body: "100MB" } },`);
    const { url } = await service.listen();
    const upload = async () => {
      let sent = 0;
      const chunk = new Uint8Array(1 << 16);
      const body = new ReadableStream<Uint8Array>({ pull(controller) { if (sent >= 800) return controller.close(); sent += 1; controller.enqueue(chunk); } });
      const response = await fetch(`${url}/billing/upload`, { method: "POST", body, duplex: "half" } as RequestInit);
      return ((await response.json()) as { received: number }).received;
    };
    const download = async () => {
      const response = await fetch(`${url}/billing/download`);
      let received = 0;
      for await (const part of response.body!) received += part.byteLength;
      return received;
    };
    /** The largest growth of the resident memory while `work` runs. */
    const growth = async (work: () => Promise<number>) => {
      Bun.gc(true);
      const before = process.memoryUsage().rss;
      let peak = before;
      const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 2);
      try {
        expect(await work()).toBe(50 * (1 << 20));
      } finally {
        clearInterval(sampler);
      }
      return peak - before;
    };
    // The first transfers warm the runtime's buffers up; the least growth of three more shows what the proxy itself
    // keeps, since the collector and the sockets only ever add noise.
    await growth(upload);
    await growth(download);
    const least = async (work: () => Promise<number>) => Math.min(await growth(work), await growth(work), await growth(work));
    expect(await least(upload)).toBeLessThan(10 * 1024 * 1024);
    expect(await least(download)).toBeLessThan(10 * 1024 * 1024);
  }, 60_000);

  test("the upstream gets the forwarding headers and its own host, never hop-by-hop headers, cookies or credentials", async () => {
    const service = await start(billing());
    const response = await service.fetch("/billing/x", {
      peer: "198.51.100.7",
      headers: { host: "api.example.com", connection: "x-secret", "x-secret": "1", cookie: "sid=abc", authorization: "Bearer t", "keep-alive": "timeout=5", te: "trailers", "x-request-id": "req-1" },
    });
    expect(response.headers.get("x-upstream")).toBe("1");
    expect(response.headers.get("x-hop")).toBeNull();
    expect(response.headers.get("keep-alive")).toBeNull();
    const headers = seen[0]!.headers;
    expect(headers["x-forwarded-for"]!.endsWith("198.51.100.7")).toBe(true);
    expect(headers["x-forwarded-proto"]).toBe("http");
    expect(headers["x-forwarded-host"]).toBe("api.example.com");
    expect(headers["x-request-id"]).toBe("req-1");
    expect(headers.host).toBe(`127.0.0.1:${upstream.port}`);
    for (const name of ["x-secret", "cookie", "authorization", "keep-alive", "te"]) expect(headers[name]).toBeUndefined();
  });
});

describe("timeouts and error answers", () => {
  test("a slow upstream answers 504, a closed port 502, and an open circuit 503", async () => {
    delayMs = 400;
    const slow = await start(billing(`, timeout: "100ms"`));
    const timedOut = await slow.fetch("/billing/slow");
    expect(timedOut.status).toBe(504);
    expect(((await timedOut.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "GATEWAY_TIMEOUT", message: "Upstream request timed out" });
    await slow.stop();
    running.length = 0;
    delayMs = 0;

    const closed = await start(`proxy: { routes: { billing: { path: "/billing/*", target: "http://127.0.0.1:9" } } },`);
    const refused = await closed.fetch("/billing/x");
    expect(refused.status).toBe(502);
    expect(((await refused.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "BAD_GATEWAY", message: "Upstream request failed" });
    await closed.stop();
    running.length = 0;

    const circuit = await start(`proxy: { routes: { billing: { path: "/billing/*", service: "billing" } } }, http: { services: { billing: { url: "https://billing.test", circuitBreaker: { failures: 1 } } } },`);
    const mock = mockHttp();
    try {
      mock.service("billing").on("GET", "/billing/x").reply(500);
      expect((await circuit.fetch("/billing/x")).status).toBe(500);
      const open = await circuit.fetch("/billing/x");
      expect(open.status).toBe(503);
      expect(((await open.json()) as { error: { code: string } }).error.code).toBe("SERVICE_UNAVAILABLE");
    } finally {
      mock.restore();
    }
  });
});

describe("logging and the disabled path", () => {
  test("the http.call entry names the route's service and the request log names the route; without proxy no route exists", async () => {
    const service = await start(billing());
    await (await service.fetch("/billing/x")).text();
    await settle();
    expect(logs().find((entry) => entry.message === "http.call")).toMatchObject({ service: "proxy/billing", status: 200 });
    expect(logs().find((entry) => entry.route === "/billing/[...rest]")).toMatchObject({ proxy: "billing", status: 200 });
    await service.stop();
    running.length = 0;

    const plain = await start("");
    expect((await plain.fetch("/billing/x")).status).toBe(404);
    expect(seen).toHaveLength(1);
  });
});
