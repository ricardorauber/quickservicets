import { afterEach, describe, expect, test } from "bun:test";
import "./index.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { defineFeature, registerNative, unregisterNative } from "./features.ts";
import { compilePathPattern, matchPathPrefix, subdomainOf } from "./features/tenancy/resolve.ts";
import { errorOf, startTestApp, type TestApp, type TestEndpointInput } from "./tenancy-test-support.ts";
import type { ServiceRequest } from "./hooks.ts";
import { entity, field } from "./testing/entities.ts";

const post = entity("Post", [field({ name: "title", type: "string" })]);
const whoami: TestEndpointInput = { path: "/whoami", handler: (_repos, req) => ({ tenant: req.tenant ?? null }) };

const running: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const app of running.splice(0)) await app.stop();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function start(tenancy: Record<string, unknown> = {}, endpoints: TestEndpointInput[] = [whoami], extra: Record<string, unknown> = {}) {
  const app = await startTestApp({ config: { tenancy, ...extra }, models: [post], endpoints });
  running.push(app);
  return app;
}

const tenantOf = async (response: Response) => ((await response.json()) as { tenant: { id: string } | null }).tenant?.id;

describe("options", () => {
  const resolve = (tenancy: Record<string, unknown>) => () => resolveConfig({ database: memoryAdapter(), tenancy } as ServiceConfig, {});

  test("subdomain without a domain, function without resolve and a path without [tenant] fail", () => {
    expect(resolve({ from: ["subdomain"] })).toThrow("tenancy.domain is required when tenancy.from lists subdomain");
    expect(resolve({ from: ["function"] })).toThrow("tenancy.resolve is required when tenancy.from lists function");
    expect(resolve({ from: ["path"], path: "/t" })).toThrow("tenancy.path must be a path with a [tenant] segment");
    expect(resolve({ from: ["nope"] })).toThrow();
  });

  test("the defaults read the x-tenant-id header and require a tenant", () => {
    const config = resolveConfig({ database: memoryAdapter(), tenancy: {} } as ServiceConfig, {});
    const options = config.features.find((feature) => feature.key === "tenancy")!.options;
    expect(options).toMatchObject({ from: ["header"], header: "x-tenant-id", path: "/t/[tenant]", required: true });
  });
});

describe("sources", () => {
  test("the header gives req.tenant.id, and a request without it answers 400 before any handler", async () => {
    const app = await start();
    expect(await tenantOf(await app.fetch("/whoami", { headers: { "x-tenant-id": "acme" } }))).toBe("acme");
    expect(await errorOf(await app.fetch("/whoami"))).toEqual({ status: 400, code: "TENANT_REQUIRED", message: "Tenant is required" });
  });

  test("a subdomain of the domain names the tenant, the port is ignored, and the bare domain has none", async () => {
    const app = await start({ from: ["subdomain"], domain: "app.example.com" });
    expect(await tenantOf(await app.fetch("/whoami", { headers: { host: "acme.app.example.com:443" } }))).toBe("acme");
    expect((await app.fetch("/whoami", { headers: { host: "app.example.com" } })).status).toBe(400);
    expect((await app.fetch("/whoami", { headers: { host: "x.acme.app.example.com" } })).status).toBe(400);
    expect(subdomainOf("Acme.App.Example.com", "app.example.com")).toBe("acme");
  });

  test("x-forwarded-host is read only from trusted proxies", async () => {
    const app = await start({ from: ["subdomain"], domain: "app.test" }, [whoami], { security: { proxy: { trust: ["10.0.0.0/8"] } } });
    const forwarded = (peer: string) =>
      app.app.server.fetch(new Request("http://internal/whoami", { headers: { host: "internal", "x-forwarded-host": "acme.app.test" } }), { peer });
    expect(await tenantOf(await forwarded("10.1.2.3"))).toBe("acme");
    expect((await forwarded("203.0.113.9")).status).toBe(400);
  });

  test("the path prefix is removed before routing, and generated creates link to the prefixed item", async () => {
    const seen: string[] = [];
    const app = await start({ from: ["path"] }, [{ path: "/whoami", handler: (_repos, req) => (seen.push(req.path), { tenant: req.tenant ?? null }) }]);
    const created = await app.fetch("/t/acme/posts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "hi" }) });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect(created.headers.get("location")).toBe(`/t/acme/posts/${id}`);
    expect(await tenantOf(await app.fetch("/t/acme/whoami"))).toBe("acme");
    expect(seen).toEqual(["/whoami"]);
    expect((await app.fetch("/whoami")).status).toBe(400);
    const pattern = compilePathPattern("/orgs/[tenant]/api");
    expect(matchPathPrefix(pattern, "/orgs/acme/api/posts")).toEqual({ tenant: "acme", rest: "/posts" });
    expect(matchPathPrefix(pattern, "/orgs/acme/other/posts")).toBeUndefined();
  });

  test("the function source resolves from anything in the request", async () => {
    const app = await start({ from: ["function"], resolve: ({ req }: { req: ServiceRequest }) => req.query.get("org") ?? undefined });
    expect(await tenantOf(await app.fetch("/whoami?org=initech"))).toBe("initech");
    expect((await app.fetch("/whoami")).status).toBe(400);
  });

  test("sources are tried in order and the first id wins", async () => {
    const app = await start({ from: ["subdomain", "header"], domain: "app.test" });
    expect(await tenantOf(await app.fetch("/whoami", { host: "acme.app.test", headers: { host: "acme.app.test", "x-tenant-id": "acme" } }))).toBe("acme");
    expect(await tenantOf(await app.fetch("/whoami", { headers: { host: "app.test", "x-tenant-id": "globex" } }))).toBe("globex");
  });
});

/** A test native whose middleware sets `req.tenant` from the credentials at order 100, like an authentication provider. */
function credentials(tenant: string) {
  registerNative(
    defineFeature({
      key: "test-auth",
      docs: { summary: "Test." },
      middleware: [{ stage: "handler", order: 100, run: (req, _res, next) => ((req.tenant = { id: tenant }), next()) }],
    }),
  );
  cleanups.push(() => unregisterNative("test-auth"));
}

describe("validation and mismatches", () => {
  test("ids outside the rule answer 400 without echoing the value", async () => {
    const app = await start();
    for (const value of ["ACME", "../x", "a b", "acme, globex", "-acme", "a".repeat(64)]) {
      const response = await app.fetch("/whoami", { headers: { "x-tenant-id": value } });
      const text = await response.text();
      expect(response.status).toBe(400);
      expect(JSON.parse(text).error).toEqual({ code: "INVALID_TENANT", message: "Invalid tenant id" });
      expect(text.includes(value)).toBe(false);
    }
  });

  test("a credential tenant and a different header answer 403; the auth source takes the credential's", async () => {
    credentials("acme");
    const app = await start({}, [whoami], { "test-auth": {} });
    expect(await errorOf(await app.fetch("/whoami", { headers: { "x-tenant-id": "globex" } }))).toEqual({ status: 403, code: "TENANT_MISMATCH", message: "Tenant does not match the credentials" });
    expect(await tenantOf(await app.fetch("/whoami", { headers: { "x-tenant-id": "acme" } }))).toBe("acme");
    await app.stop();
    const auth = await start({ from: ["auth"] }, [whoami], { "test-auth": {} });
    expect(await tenantOf(await auth.fetch("/whoami"))).toBe("acme");
  });
});

describe("exemptions", () => {
  test("@tenancy off, @tenancy required=false, the health routes, the docs and exempt() need no tenant", async () => {
    registerNative(
      defineFeature({
        key: "test-public",
        docs: { summary: "Test." },
        after: ["tenancy"],
        setup: (ctx) => {
          ctx.feature("tenancy").exempt("/public/*");
          ctx.app.route("GET", "/public/info", () => ({ open: true }));
        },
      }),
    );
    cleanups.push(() => unregisterNative("test-public"));
    const app = await start(
      {},
      [
        { method: "POST", path: "/signup", handler: (_repos, req) => ({ tenant: req.tenant ?? null }), tags: { tenancy: { on: false, options: {} } } },
        { path: "/optional", handler: (_repos, req) => ({ tenant: req.tenant ?? null }), tags: { tenancy: { on: true, options: { required: false } } } },
        whoami,
      ],
      { health: {}, "test-public": {} },
    );
    expect((await app.fetch("/signup", { method: "POST", headers: { "x-tenant-id": "acme" } })).status).toBe(200);
    expect(await tenantOf(await app.fetch("/signup", { method: "POST", headers: { "x-tenant-id": "acme" } }))).toBeUndefined();
    expect((await app.fetch("/health/live")).status).toBe(200);
    expect((await app.fetch("/public/info")).status).toBe(200);
    expect(await tenantOf(await app.fetch("/optional"))).toBeUndefined();
    expect(await tenantOf(await app.fetch("/optional", { headers: { "x-tenant-id": "acme" } }))).toBe("acme");
    expect((await app.fetch("/whoami")).status).toBe(400);
    expect(() => app.lifecycle.middleware).not.toThrow();
  });

  test("without tenancy no tenancy middleware is registered", async () => {
    const app = await startTestApp({ models: [post], endpoints: [whoami] });
    running.push(app);
    expect(app.lifecycle.middleware.filter((entry) => entry.owner === "tenancy")).toEqual([]);
    expect(app.config.features.some((feature) => feature.key === "tenancy")).toBe(false);
    expect(await tenantOf(await app.fetch("/whoami"))).toBeUndefined();
  });
});
