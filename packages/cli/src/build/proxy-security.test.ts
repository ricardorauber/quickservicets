import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { startTestService, type TestService } from "../testing/service.ts";
import { routeIndexStats } from "../../../core/src/features/security/routes.ts";

type Seen = { method: string; path: string; bytes: number; aborted: boolean };
const seen: Seen[] = [];
let upstream: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 60,
    async fetch(request) {
      const url = new URL(request.url);
      const entry: Seen = { method: request.method, path: url.pathname, bytes: 0, aborted: false };
      seen.push(entry);
      try {
        if (request.body) for await (const chunk of request.body) entry.bytes += chunk.byteLength;
      } catch {
        entry.aborted = true;
        return new Response(null, { status: 499 });
      }
      const headers: Record<string, string> = { "access-control-allow-origin": "*", "access-control-allow-credentials": "true" };
      if (url.pathname.endsWith("/own-csp")) headers["content-security-policy"] = "default-src 'none'; img-src 'self'";
      return Response.json({ received: entry.bytes }, { headers });
    },
  });
});
afterAll(() => upstream.stop(true));

const CONFIG = (extra: string) => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({
  database: memoryAdapter(),
  logger: { info() {}, warn() {}, error() {} },
  ${extra}
});
`;
const target = () => `http://127.0.0.1:${upstream.port}`;
const route = (extra: string) => `proxy: { routes: { billing: { path: "/billing/*", target: "${target()}"${extra} } } },`;

const running: TestService[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
  seen.length = 0;
});

async function start(extra: string, files: Record<string, string> = {}) {
  const service = await startTestService({ files: { "quickservicets.config.ts": CONFIG(extra), "entities/Post.ts": "export type Post = { title: string };\n", ...files } });
  running.push(service);
  return service;
}

/** A body streamed without a declared length, of `megabytes` MB. */
const streamed = (megabytes: number) => {
  let sent = 0;
  const chunk = new Uint8Array(1 << 16);
  return new ReadableStream<Uint8Array>({ pull(controller) { if (sent >= megabytes * 16) return controller.close(); sent += 1; controller.enqueue(chunk); } });
};

describe("routeOptions", () => {
  test("a feature's route options refuse a public peer on its paths only, and calling them after setup throws", async () => {
    const service = await start("partner: {},", {
      "features/partner/index.ts": `import { defineFeature } from "@quickservicets/core";
export default defineFeature({
  key: "partner",
  after: ["security"],
  setup(ctx) {
    ctx.feature("security").routeOptions("/partner/*", { ip: { allow: ["10.0.0.0/8"] } });
    ctx.app.onStart(() => void ((globalThis as any).lateRouteOptions = () => ctx.feature("security").routeOptions("/late/*", { ip: { allow: ["10.0.0.0/8"] } })));
  },
});
`,
    });
    const refused = await service.fetch("/partner/x", { peer: "203.0.113.9" });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toBe("Address not allowed");
    expect((await service.fetch("/partner/x", { peer: "10.1.2.3" })).status).toBe(404);
    expect((await service.fetch("/posts", { peer: "203.0.113.9" })).status).toBe(200);
    expect(() => (globalThis as { lateRouteOptions?: () => void }).lateRouteOptions!()).toThrow("security routeOptions() is only available during setup");
  });
});

describe("proxy route options", () => {
  test("rateLimit refuses the third request with 429 before the upstream, while other routes still answer", async () => {
    const service = await start(route(`, rateLimit: { limit: "2/min" }`));
    for (let i = 0; i < 2; i++) expect((await service.fetch("/billing/x", { peer: "198.51.100.7" })).status).toBe(200);
    expect((await service.fetch("/billing/x", { peer: "198.51.100.7" })).status).toBe(429);
    expect(seen).toHaveLength(2);
    expect((await service.fetch("/posts", { peer: "198.51.100.7" })).status).toBe(200);
  });
});

describe("CORS at the gateway", () => {
  test("preflights are answered without the upstream, and only the gateway's CORS headers reach the browser", async () => {
    const service = await start(route(`, cors: { origins: ["https://app.example.com"] }`));
    const preflight = await service.fetch("/billing/x", { method: "OPTIONS", headers: { origin: "https://app.example.com", "access-control-request-method": "GET" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    expect(seen).toHaveLength(0);
    const response = await service.fetch("/billing/x", { headers: { origin: "https://app.example.com" } });
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });
});

describe("streamed body limits", () => {
  test("maxBodySize answers 413 and aborts the upstream; a larger one lets a body above the global limit through", async () => {
    const small = await start(route(`, maxBodySize: "1MB"`));
    const { url } = await small.listen();
    const refused = await fetch(`${url}/billing/upload`, { method: "POST", body: streamed(2), duplex: "half" } as RequestInit);
    expect(refused.status).toBe(413);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toBe("Request body is larger than 1MB");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen.at(-1)!.bytes).toBeLessThan(2 * 1024 * 1024);
    await small.stop();
    running.length = 0;

    const large = await start(`security: { limits: { body: "1MB" } }, ${route(`, maxBodySize: "50MB"`)}`);
    const served = await large.listen();
    const answer = await fetch(`${served.url}/billing/upload`, { method: "POST", body: streamed(20), duplex: "half" } as RequestInit);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ received: 20 * 1024 * 1024 });
    expect((await fetch(`${served.url}/posts`, { method: "POST", body: streamed(2), duplex: "half", headers: { "content-type": "application/json" } } as RequestInit)).status).toBe(413);
  }, 30_000);
});

describe("security headers and the route index", () => {
  test("an upstream's own security headers are kept, others get the defaults, and routes without options add no index entry", async () => {
    const builds = routeIndexStats.builds;
    const service = await start(route(""));
    expect(routeIndexStats.builds).toBe(builds);
    const own = await service.fetch("/billing/own-csp");
    expect(own.headers.get("content-security-policy")).toBe("default-src 'none'; img-src 'self'");
    const plain = await service.fetch("/billing/x");
    expect(plain.headers.get("content-security-policy")).not.toBeNull();
    expect(plain.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
