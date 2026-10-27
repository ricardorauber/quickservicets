import { afterAll, describe, expect, test } from "bun:test";
import { memoryAdapter } from "./adapters/memory.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { defineFeature } from "./features.ts";
import { joinPath } from "./features/http/client.ts";
import { http, type HttpClientError } from "./index.ts";
import { useTestResolver } from "./testing/index.ts";
import { resetHttpConfig, startHttpApp, upstream } from "./http-test-support.ts";

declare module "./features/http/client.ts" {
  interface HttpServiceNames {
    billing: true;
  }
}

afterAll(() => resetHttpConfig());

const failure = async (work: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof work === "function" ? work() : work);
  } catch (error) {
    return error as HttpClientError;
  }
  throw new Error("expected the call to fail");
};

const resolve = (http: Record<string, unknown>, env: Record<string, string> = {}) => resolveConfig({ database: memoryAdapter(), http } as ServiceConfig, env);

/** A local server reached as billing.internal through a test resolver, answering what it received. */
function billingServer(delayMs = 0) {
  return upstream(async (request) => {
    if (delayMs > 0) await Bun.sleep(delayMs);
    const url = new URL(request.url);
    return Response.json({ path: url.pathname + url.search, authorization: request.headers.get("authorization"), apiKey: request.headers.get("x-api-key"), plan: request.headers.get("x-plan") });
  });
}

describe("the services option", () => {
  test("services resolve with their defaults; names and the single authentication method are checked", () => {
    const options = resolve({ services: { billing: { url: "http://billing.internal/v1", auth: { apiKey: { value: "k" } } } } }).features.find((feature) => feature.key === "http")!.options;
    expect((options.services as Record<string, { auth: { apiKey: { header: string } } }>).billing!.auth.apiKey.header).toBe("x-api-key");
    expect(() => resolve({ services: { Billing: { url: "http://x.test" } } })).toThrow("Invalid http.services.Billing: a service name starts with a lowercase letter");
    expect(() => resolve({ services: { billing: { url: "http://x.test", auth: { bearer: "a", basic: { username: "u", password: "p" } } } } })).toThrow(
      "Invalid http.services.billing.auth: use only one of bearer, basic or apiKey",
    );
    expect(() => resolve({ services: { billing: { url: "not a url" } } })).toThrow("Invalid http.services.billing.url");
  });
});

describe("paths", () => {
  test("paths join the base URL's path; absolute URLs, // and paths without / are refused", () => {
    expect(joinPath("https://api.x/v1", "/invoices?x=1").href).toBe("https://api.x/v1/invoices?x=1");
    expect(joinPath("https://api.x/v1/", "/invoices").href).toBe("https://api.x/v1/invoices");
    expect(joinPath("https://api.x", "/a/b").href).toBe("https://api.x/a/b");
    resolve({ services: { billing: { url: "http://billing.internal/v1" } } });
    for (const path of ["https://evil.test/x", "invoices", "//evil.test/x"]) {
      expect(() => http.service("billing").get(path)).toThrow(`http.service("billing") takes a path starting with /, got ${path}`);
    }
  });
});

describe("headers, authentication and timeout", () => {
  test("calls carry the service's headers and authentication under the call's own, and the service's timeout", async () => {
    const server = billingServer();
    const slow = billingServer(2000);
    const restore = useTestResolver({ "billing.internal": "127.0.0.1", "slow.internal": "127.0.0.1" });
    try {
      resolve({
        services: {
          billing: { url: `http://billing.internal:${server.port}/v1`, headers: { "x-plan": "pro" }, auth: { bearer: "token-123456" }, timeout: "1s" },
          keyed: { url: `http://billing.internal:${server.port}`, auth: { apiKey: { value: "key-1" } } },
          basic: { url: `http://billing.internal:${server.port}`, auth: { basic: { username: "ana", password: "pw" } } },
          slow: { url: `http://slow.internal:${slow.port}`, timeout: "1s" },
        },
      });
      expect(await http.service("billing").get("/invoices").send()).toEqual({ path: "/v1/invoices", authorization: "Bearer token-123456", apiKey: null, plan: "pro" });
      expect(await http.service("billing").get("/invoices").header("authorization", "Bearer other").header("x-plan", "free").send()).toMatchObject({ authorization: "Bearer other", plan: "free" });
      expect(await http.service("keyed" as "billing").get("/x").send()).toMatchObject({ apiKey: "key-1" });
      expect(await http.service("basic" as "billing").get("/x").send()).toMatchObject({ authorization: `Basic ${btoa("ana:pw")}` });
      const started = performance.now();
      const timeout = await failure(http.service("slow" as "billing").get("/x").send());
      expect([timeout.code, timeout.service]).toEqual(["TIMEOUT", "slow"]);
      expect(performance.now() - started).toBeLessThan(1800);
      expect(await http.service("slow" as "billing").get("/x").timeout("3s").send()).toMatchObject({ path: "/x" });
    } finally {
      restore();
      server.stop();
      slow.stop();
    }
  }, 10_000);
});

describe("unknown services", () => {
  test("an unknown name throws how to declare it", () => {
    resolve({});
    // @ts-expect-error: only declared services, and the <feature>/<name> services of features, are names.
    expect(() => http.service("nope")).toThrow("Unknown service nope; add it to http.services in quickservicets.config.ts");
  });
});

describe("environment and secrets", () => {
  test("variables override a service's options; secrets never show in errors or the serialized config", async () => {
    const server = upstream(() => Response.json({ error: "down" }, { status: 500 }));
    const restore = useTestResolver({ "billing-2.internal": "127.0.0.1" });
    try {
      const config = resolve(
        { services: { billing: { url: "http://billing.internal/v1", auth: { bearer: "token-123456" } } } },
        { QS_HTTP_SERVICES_BILLING_URL: `http://billing-2.internal:${server.port}/v1`, QS_HTTP_SERVICES_BILLING_TIMEOUT: "2s" },
      );
      const error = await failure(http.service("billing").get("/invoices?page=1").send());
      expect([error.code, error.status, error.service, error.url]).toEqual(["HTTP_STATUS", 500, "billing", `http://billing-2.internal:${server.port}/v1/invoices?page=1`]);
      expect(server.seen[0]!.headers.get("authorization")).toBe("Bearer token-123456");
      expect(JSON.stringify({ message: error.message, url: error.url, body: error.body, service: error.service })).not.toContain("token-123456");
      expect(JSON.stringify(config)).not.toContain("token-123456");
      expect(JSON.stringify(config)).toContain('"bearer":"[secret]"');
      const bearer = resolve({ services: { billing: { url: "http://billing.internal/v1" } } }, { QS_HTTP_SERVICES_BILLING_AUTH_BEARER: "from-env-123" });
      expect(JSON.stringify(bearer)).toContain('"bearer":"[secret]"');
    } finally {
      restore();
      server.stop();
    }
  });
});

describe("SSRF trust", () => {
  test("calls through a service reach its internal host; the same host by URL and other redirect targets are checked", async () => {
    const server = upstream((request) => (new URL(request.url).pathname === "/v1/away" ? Response.redirect("http://10.0.0.9/x", 302) : Response.json({ ok: true })));
    const restore = useTestResolver({ "billing.internal": "127.0.0.1" });
    try {
      resolve({ services: { billing: { url: `http://billing.internal:${server.port}/v1` } } });
      expect(await http.service("billing").get("/invoices").send()).toEqual({ ok: true });
      expect((await failure(http.get(`http://billing.internal:${server.port}/v1/invoices`).send())).code).toBe("SSRF_BLOCKED");
      expect((await failure(http.service("billing").get("/away").send())).message).toBe("Blocked request to 10.0.0.9: 10.0.0.9 is a private address");
    } finally {
      restore();
      server.stop();
    }
  });
});

describe("services added by features", () => {
  test("a feature adds <key>/<name> services during setup only; a taken name fails startup naming both", async () => {
    const server = upstream(() => Response.json({ issuer: true }));
    let addLater: (() => void) | undefined;
    const sso = defineFeature({
      key: "sso",
      after: ["http"],
      setup(ctx) {
        ctx.feature("http").addService("issuer", { url: server.url, auth: { bearer: "sso-secret-1" } });
        addLater = () => ctx.feature("http").addService("late", { url: server.url });
      },
    });
    const app = await startHttpApp({ http: { allow: [] } }, { "GET /issuer": () => http.service("sso/issuer").get("/keys").send() }, [sso]);
    try {
      expect(await (await app.fetch("/issuer")).json()).toEqual({ issuer: true });
      expect(server.seen[0]!.headers.get("authorization")).toBe("Bearer sso-secret-1");
      expect(() => addLater!()).toThrow("http addService() can only be called during setup");
    } finally {
      await app.stop();
    }
    const clash = defineFeature({ key: "sso", after: ["http"], setup: (ctx) => ctx.feature("http").addService("sso", { url: server.url }) });
    const failed = await failure(() => startHttpApp({ http: { services: { sso: { url: server.url } } } }, {}, [clash]));
    expect(failed.message).toContain("Service sso is declared by http.services and sso");
    server.stop();
  });
});
