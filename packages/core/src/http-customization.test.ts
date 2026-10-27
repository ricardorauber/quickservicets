import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { memoryAdapter } from "./adapters/memory.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { defineFeature } from "./features.ts";
import { retryTiming } from "./features/http/retry.ts";
import type { ServiceRequest } from "./hooks.ts";
import { http, HttpClientError, type HttpMock } from "./index.ts";
import { useTestResolver } from "./testing/index.ts";
import { resetHttpConfig, startHttpApp, upstream } from "./http-test-support.ts";

declare module "./features/http/client.ts" {
  interface HttpServiceNames {
    billing: true;
  }
}

let mock: HttpMock | undefined;
const realTiming = { ...retryTiming };
afterEach(() => {
  mock?.restore();
  mock = undefined;
  Object.assign(retryTiming, realTiming);
});
afterAll(() => resetHttpConfig());

const failure = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error("expected the call to fail");
};

const httpOptionsOf = (env: Record<string, string>, http: Record<string, unknown> = {}) =>
  resolveConfig({ database: memoryAdapter(), http } as ServiceConfig, env).features.find((feature) => feature.key === "http")!.options as Record<string, any>;

describe("environment overrides", () => {
  test("every option has its variable, per-service and modifier options included", async () => {
    expect(httpOptionsOf({}).timeout).toBe("10s");
    const options = httpOptionsOf(
      { QS_HTTP_TIMEOUT: "1s", QS_HTTP_MAX_RESPONSE_SIZE: "2MB", QS_HTTP_USER_AGENT: "agent/1", QS_HTTP_SSRF: "false", QS_HTTP_ALLOW: "127.0.0.1/32,*.internal", QS_HTTP_MAX_REDIRECTS: "2", QS_HTTP_LOG: "errors" },
      {},
    );
    expect([options.timeout, options.maxResponseSize, options.userAgent, options.ssrf, options.allow, options.maxRedirects, options.log]).toEqual(["1s", "2MB", "agent/1", false, ["127.0.0.1/32", "*.internal"], 2, "errors"]);
    const services = httpOptionsOf({ QS_HTTP_SERVICES_BILLING_RETRY_ENABLED: "true", QS_HTTP_SERVICES_BILLING_CIRCUIT_BREAKER_FAILURES: "3" }, { services: { billing: { url: "http://billing.internal" } } }).services.billing;
    expect([services.retry.enabled, services.circuitBreaker.failures]).toEqual([true, 3]);
    expect(() => resolveConfig({ database: memoryAdapter() } as ServiceConfig, { QS_HTTP_ENABLED: "false" })).not.toThrow();
    expect(() => http.get("http://x.test/")).toThrow("http is disabled");

    const server = upstream(() => Response.json({ ok: true }));
    try {
      resolveConfig({ database: memoryAdapter() } as ServiceConfig, { QS_HTTP_ALLOW: "127.0.0.1/32" });
      expect(await http.get(server.url).send()).toEqual({ ok: true });
      resolveConfig({ database: memoryAdapter() } as ServiceConfig, { QS_HTTP_TIMEOUT: "1s" });
    } finally {
      server.stop();
    }
    mock = http.mock();
    mock.on("GET", "http://billing.internal/x").reply(200, { ok: true });
    mock.on("GET", "http://billing.internal/x").reply(503).once();
    Object.assign(retryTiming, { sleep: async () => undefined });
    resolveConfig({ database: memoryAdapter(), http: { services: { billing: { url: "http://billing.internal" } } } } as ServiceConfig, { QS_HTTP_SERVICES_BILLING_RETRY_ENABLED: "true" });
    expect(await http.service("billing").get("/x").send()).toEqual({ ok: true });
  });
});

describe("per-request headers and authentication", () => {
  test("functions of the request compute the headers on every call, with no request outside one; a bad result fails the call", async () => {
    const app = await startHttpApp(
      {
        http: {
          services: {
            billing: {
              url: "http://billing.internal",
              headers: ({ tenant }: { tenant?: { plan?: string } }) => ({ "x-plan": tenant?.plan ?? "free" }),
              auth: ({ service }: { service: string }) => ({ bearer: `token-for-${service}` }),
            },
            broken: { url: "http://broken.internal", headers: () => 42 },
          },
        },
      },
      {
        "GET /plan": (req: ServiceRequest) => {
          req.tenant = { id: "acme", plan: "pro" } as ServiceRequest["tenant"];
          return req.http.service("billing").get("/x").send();
        },
      },
    );
    try {
      mock = http.mock();
      mock.on("*", "http://*").replyWith(({ headers }) => ({ status: 200, body: { plan: headers.get("x-plan"), auth: headers.get("authorization") } }));
      expect(await (await app.fetch("/plan")).json()).toEqual({ plan: "pro", auth: "Bearer token-for-billing" });
      expect(await http.service("billing").get("/x").send()).toEqual({ plan: "free", auth: "Bearer token-for-billing" });
      const broken = await failure(http.service("broken" as "billing").get("/x").send());
      expect(broken.message).toContain("http.services.broken.headers");
    } finally {
      await app.stop();
    }
    resolveConfig({ database: memoryAdapter(), http: { services: { billing: { url: "http://billing.internal", headers: () => ({ "x-plan": "fn" }) } } } } as ServiceConfig, {
      QS_HTTP_SERVICES_BILLING_HEADERS: '{"x-plan":"variable"}',
    });
    mock ??= http.mock();
    expect(await http.service("billing").get("/x").send()).toMatchObject({ plan: "variable" });
  });
});

describe("hooks", () => {
  test("beforeRequest changes every attempt or cancels; afterResponse and onError observe; a failing after-hook is logged", async () => {
    Object.assign(retryTiming, { sleep: async () => undefined });
    const seen: string[] = [];
    const hooks = defineFeature({
      key: "audit-calls",
      after: ["http"],
      setup(ctx) {
        ctx.feature("http").afterResponse(({ response, durationMs }) => void seen.push(`feature:${response.status}:${typeof durationMs}`));
      },
    });
    const app = await startHttpApp(
      {
        http: {
          services: { billing: { url: "http://billing.internal", retry: true } },
          beforeRequest: (request: { headers: Headers; attempt: number; url: string }) => {
            if (request.url.endsWith("/forbidden")) throw new Error("not allowed");
            request.headers.set("x-signature", `sig-${request.attempt}`);
            return request;
          },
          afterResponse: [({ response }: { response: { status: number } }) => void seen.push(`after:${response.status}`), () => Promise.reject(new Error("observer broke"))],
          onError: ({ error }: { error: HttpClientError }) => void seen.push(`error:${error.code}`),
        },
      },
      {},
      [hooks],
    );
    try {
      mock = http.mock();
      mock.on("GET", "http://billing.internal/x").reply(200, { ok: true });
      mock.on("GET", "http://billing.internal/x").reply(503).once();
      mock.on("GET", "http://slow.test/").reply(200).delay(500);
      expect(await http.service("billing").get("/x").send()).toEqual({ ok: true });
      expect(mock.calls.map((call) => call.headers["x-signature"])).toEqual(["sig-1", "sig-2"]);
      expect(seen).toEqual(["after:503", "feature:503:number", "after:200", "feature:200:number"]);
      expect(app.entries.filter((entry) => entry.message === "feature.hook.failed")).toHaveLength(2);
      const cancelled = await failure(http.get("http://api.test/forbidden").send());
      expect([cancelled.message, cancelled instanceof HttpClientError]).toEqual(["not allowed", false]);
      expect(mock.calls).toHaveLength(2);
      expect((await failure(http.get("http://slow.test/").timeout(100).send())).code).toBe("TIMEOUT");
      expect(seen.at(-1)).toBe("error:TIMEOUT");
    } finally {
      await app.stop();
    }
  });
});

describe("the transport", () => {
  test("a replacement transport gets the validated address, and redirects and http.call entries keep working; a mock wins over it", async () => {
    const received: { url: string; address?: string; host: string | null }[] = [];
    const transport = {
      async fetch(request: Request, { address }: { signal: AbortSignal; address?: string }) {
        received.push({ url: request.url, address, host: request.headers.get("host") });
        if (new URL(request.url).pathname === "/old") return new Response(null, { status: 302, headers: { location: "/new" } });
        return Response.json({ via: "transport" });
      },
    };
    const restore = useTestResolver({ "api.test": "203.0.113.9", "local.test": "127.0.0.1" });
    const app = await startHttpApp({ http: { allow: ["api.test"], transport } });
    try {
      expect(await http.get("http://api.test/old").send()).toEqual({ via: "transport" });
      expect(received).toEqual([
        { url: "http://api.test/old", address: "203.0.113.9", host: null },
        { url: "http://api.test/new", address: "203.0.113.9", host: null },
      ]);
      expect((await failure(http.get("http://local.test/").send())).code).toBe("SSRF_BLOCKED");
      expect(app.entries.filter((entry) => entry.message === "http.call").map((entry) => entry.status)).toEqual([200, 0]);
      mock = http.mock();
      mock.on("GET", "http://api.test/new").reply(200, { via: "mock" });
      expect(await http.get("http://api.test/new").send()).toEqual({ via: "mock" });
      expect(received).toHaveLength(2);
    } finally {
      await app.stop();
      restore();
    }
  });
});

describe("the reference page", () => {
  test("lists the per-service variables, the hooks, the transport and modifier contracts, and says there are no tags and no files", () => {
    const page = readFileSync(join(import.meta.dir, "../../../docs/src/content/docs/reference/features/http.mdx"), "utf8");
    for (const text of ["QS_HTTP_SERVICES_<NAME>_URL", "`http.beforeRequest`", "`http.afterResponse`", "`http.onError`", "## HttpTransport", "## Modifiers", "`circuitBreaker`", "`bulkhead`", "`cache`", "The client has no tags", "no files to override"]) {
      expect(page).toContain(text);
    }
  });
});
