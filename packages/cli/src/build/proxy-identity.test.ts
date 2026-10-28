import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { testAuth } from "@quickservicets/core/testing";
import { startTestService, type TestService } from "../testing/service.ts";
import * as identity from "../../../core/src/features/proxy/identity.ts";

type Seen = { method: string; path: string; headers: Record<string, string> };
const seen: Seen[] = [];
let upstream: ReturnType<typeof Bun.serve>;
/** A second QuickService.ts behind the gateway, trusting its signed identity. */
let behind: TestService | undefined;
let behindUrl = "";

beforeAll(() => {
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      seen.push({ method: request.method, path: `${url.pathname}${url.search}`, headers: Object.fromEntries(request.headers) });
      return Response.json({ ok: true });
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

const running: TestService[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
  if (behind) await behind.stop();
  behind = undefined;
  seen.length = 0;
});

async function start(extra: string, auth = false) {
  const service = await startTestService({ files: { "quickservicets.config.ts": CONFIG(extra) }, ...(auth ? { auth: testAuth() } : {}) });
  running.push(service);
  return service;
}

const route = (extra: string, to = target()) => `proxy: { routes: { billing: { path: "/billing/*", target: "${to}"${extra} } } },`;

describe("rewriting", () => {
  test("stripPrefix drops the prefix, rewrite fills a template, both together fail, and the query string is kept", async () => {
    const strip = await start(route(", stripPrefix: true"));
    await strip.fetch("/billing/invoices?page=2");
    expect(seen.at(-1)!.path).toBe("/invoices?page=2");
    await strip.stop();
    running.length = 0;

    const rewrite = await start(route(`, rewrite: "/api/v2/[...rest]"`));
    await rewrite.fetch("/billing/invoices?page=2");
    expect(seen.at(-1)!.path).toBe("/api/v2/invoices?page=2");
    await rewrite.stop();
    running.length = 0;

    await expect(start(route(`, stripPrefix: true, rewrite: "/x/[...rest]"`))).rejects.toThrow("Invalid proxy.routes.billing: use stripPrefix or rewrite, not both");
  });
});

describe("route authentication", () => {
  test("a required route answers 401 without calling the upstream, roles answer 403, and checks need the auth native", async () => {
    const service = await start(`auth: {}, ${route(`, auth: "required", roles: ["finance"]`)}`, true);
    const anonymous = await service.fetch("/billing/x");
    expect(anonymous.status).toBe(401);
    expect(((await anonymous.json()) as { error: { message: string } }).error.message).toBe("Authentication required");
    expect((await service.fetch("/billing/x", { headers: { "x-test-user": "u1;roles=sales" } })).status).toBe(403);
    expect(seen).toHaveLength(0);
    expect((await service.fetch("/billing/x", { headers: { "x-test-user": "u1;roles=finance" } })).status).toBe(200);
    expect(seen).toHaveLength(1);
    await service.stop();
    running.length = 0;

    const scoped = await start(`auth: {}, ${route(`, scopes: ["billing:read"]`)}`, true);
    expect((await scoped.fetch("/billing/x", { headers: { "x-test-user": "u1;scopes=other" } })).status).toBe(403);
    expect((await scoped.fetch("/billing/x", { headers: { "x-test-user": "u1;scopes=billing:read" } })).status).toBe(200);
    await scoped.stop();
    running.length = 0;

    await expect(start(route(`, auth: "required"`))).rejects.toThrow("proxy.routes.billing checks users, which needs the auth native; add auth: {} to quickservicets.config.ts");
  });
});

describe("identity headers", () => {
  test("client identity headers never pass; the real user and tenant do, roles and credentials only when listed", async () => {
    const plain = await start(route(""));
    await plain.fetch("/billing/x", { headers: { "x-user-id": "admin", "x-tenant-id": "other", "x-user-roles": "root", "x-quickservicets-identity": "t=1,v1=00" } });
    for (const name of ["x-user-id", "x-tenant-id", "x-user-roles", "x-quickservicets-identity"]) expect(seen[0]!.headers[name]).toBeUndefined();
    await plain.stop();
    running.length = 0;

    const forwarding = await start(`auth: {}, tenancy: { from: ["auth"], source: "config", tenants: { acme: {} } }, ${route(`, forward: ["user", "tenant", "roles", "authorization"]`)}`, true);
    await forwarding.fetch("/billing/x", { headers: { "x-test-user": "u1;roles=a,b;tenant=acme", "x-user-id": "admin", "x-tenant-id": "other", authorization: "Bearer abc" } });
    expect(seen.at(-1)!.headers).toMatchObject({ "x-user-id": "u1", "x-tenant-id": "acme", "x-user-roles": "a,b", authorization: "Bearer abc" });
    await forwarding.stop();
    running.length = 0;

    const defaults = await start(`auth: {}, tenancy: { from: ["auth"], source: "config", tenants: { acme: {} } }, ${route("")}`, true);
    await defaults.fetch("/billing/x", { headers: { "x-test-user": "u1;roles=a,b;tenant=acme", authorization: "Bearer abc" } });
    expect(seen.at(-1)!.headers["x-user-id"]).toBe("u1");
    expect(seen.at(-1)!.headers["x-tenant-id"]).toBe("acme");
    expect(seen.at(-1)!.headers["x-user-roles"]).toBeUndefined();
    expect(seen.at(-1)!.headers.authorization).toBeUndefined();
  });

  test("the signed identity reaches an upstream using proxyIdentity, and changed values, a wrong secret or an old signature answer 401", async () => {
    behind = await startTestService({
      files: {
        "quickservicets.config.ts": `import { defineConfig, memoryAdapter, proxyIdentity } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), logger: { info() {}, warn() {}, error() {} }, auth: { providers: [proxyIdentity({ secret: "gateway-secret-1" })] } });
`,
        "endpoints/billing/me/get.ts": `import type { Repositories, ServiceRequest } from "@quickservicets/core";
export default (_repos: Repositories, req: ServiceRequest) => ({ user: req.user?.id ?? null, roles: req.user?.roles ?? [], tenant: req.tenant?.id ?? null });
`,
      },
    });
    behindUrl = (await behind.listen()).url;
    const gateway = await start(`auth: {}, tenancy: { from: ["auth"], source: "config", tenants: { acme: {} } }, proxy: { identity: { secret: "gateway-secret-1" }, routes: { billing: { path: "/billing/*", target: "${behindUrl}", forward: ["user", "roles", "tenant"] } } },`, true);
    const answer = await gateway.fetch("/billing/me", { headers: { "x-test-user": "u1;roles=a,b;tenant=acme" } });
    expect(await answer.json()).toEqual({ user: "u1", roles: ["a", "b"], tenant: "acme" });

    const now = Math.floor(Date.now() / 1000);
    const values = { user: "u1", roles: "a,b", tenant: "acme" };
    const call = (headers: Record<string, string>) => behind!.fetch("/billing/me", { headers: { "x-user-id": "u1", "x-user-roles": "a,b", "x-tenant-id": "acme", ...headers } });
    const good = identity.signIdentity("gateway-secret-1", now, "GET", "/billing/me", values);
    expect((await call({ "x-quickservicets-identity": good })).status).toBe(200);
    expect((await call({ "x-quickservicets-identity": good, "x-user-id": "admin" })).status).toBe(401);
    expect((await call({ "x-quickservicets-identity": identity.signIdentity("wrong-secret-11", now, "GET", "/billing/me", values) })).status).toBe(401);
    expect((await call({ "x-quickservicets-identity": identity.signIdentity("gateway-secret-1", now - 120, "GET", "/billing/me", values) })).status).toBe(401);
  });

  test("a route without rewriting, forwarding or identity signs nothing and builds no path", async () => {
    const sign = spyOn(identity, "signIdentity");
    try {
      const service = await start(route(`, forward: []`));
      await service.fetch("/billing/x?y=1");
      expect(sign).not.toHaveBeenCalled();
      expect(seen[0]!.path).toBe("/billing/x?y=1");
      expect(seen[0]!.headers["x-user-id"]).toBeUndefined();
    } finally {
      sign.mockRestore();
    }
  });
});
