import { afterEach, describe, expect, test } from "bun:test";
import { dispatchRoute } from "@quickservicets/core";
import { testAuth } from "@quickservicets/core/testing";
import { startTestService, type TestService } from "../testing/service.ts";

const running: TestService[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
});

type Seen = { stages: string[]; users: unknown[]; tenants: unknown[] };
const seen = () => (globalThis as unknown as { dispatchSeen: Seen }).dispatchSeen;

/** A feature recording which stages run, and what the handler stage sees. */
const PROBE = `import { defineFeature } from "@quickservicets/core";
export default defineFeature({
  key: "probe",
  setup(ctx) {
    const seen = (globalThis as unknown as { dispatchSeen: { stages: string[] } }).dispatchSeen;
    ctx.app.use({ stage: "request", run: (input, next) => (seen.stages.push("request " + input.url.pathname), next()) });
    ctx.app.use({ stage: "handler", order: 2000, run: (req, _res, next) => (seen.stages.push("handler " + req.path), next()) });
  },
});
`;
/** POST /relay dispatches the route its body names, from the request, and answers what the dispatch returned. */
const RELAY = `import { dispatchRoute, type ServiceRequest } from "@quickservicets/core";
export default async (_repos: unknown, req: ServiceRequest) => dispatchRoute(req, (await req.json()) as never);
`;
/** GET /whoami answers the request's user and tenant, as the dispatched handler sees them. */
const WHOAMI = `import type { ServiceRequest } from "@quickservicets/core";
export default (_repos: unknown, req: ServiceRequest) => ({ user: req.user?.id ?? null, tenant: (req.tenant as { id?: string } | undefined)?.id ?? null, ip: req.ip, id: req.id });
`;

const CONFIG = (keys: string) => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), logger: { info() {}, warn() {}, error() {} }, ${keys} });
`;

async function start(keys: string, files: Record<string, string>, auth = false) {
  (globalThis as unknown as { dispatchSeen: Seen }).dispatchSeen = { stages: [], users: [], tenants: [] };
  const service = await startTestService({
    files: { "quickservicets.config.ts": CONFIG(keys), "endpoints/relay/post.ts": RELAY, "endpoints/whoami/get.ts": WHOAMI, ...files },
    ...(auth ? { auth: testAuth() } : {}),
  });
  running.push(service);
  return service;
}

const relay = async (service: TestService, call: unknown, headers: Record<string, string> = {}) =>
  (await (await service.fetch("/relay", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(call) })).json()) as { status: number; headers: Record<string, string>; body: any };

describe("dispatchRoute", () => {
  test("runs the route's handler stage, hooks, filters, field selection and populate like HTTP, without the request stage", async () => {
    const service = await start("probe: {}", {
      "features/probe/index.ts": PROBE,
      "entities/Author.ts": "export type Author = { name: string };\n",
      "entities/Post.ts": 'import type { Author } from "./Author";\n/** @stamp */\nexport type Post = { title: string; status: string; author?: Author };\n',
      "hooks/stamp.ts": 'import { definePostHook } from "@quickservicets/core";\nexport default definePostHook((data) => ({ ...(data as object), stamped: true }));\n',
    });
    const author = (await (await service.fetch("/authors", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Ada" }) })).json()) as { id: string };
    for (let index = 0; index < 7; index++) {
      await service.fetch("/posts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: `p${index}`, status: index % 3 === 0 ? "published" : "draft", author: author.id }) });
    }
    const query = { "where[status][eq]": "draft", limit: "3", fields: "title,status,author", populate: "author", sort: "title" };
    const http = await service.fetch(`/posts?${new URLSearchParams(query)}`);
    seen().stages.length = 0;
    const dispatched = await relay(service, { method: "GET", path: "/posts", query });
    expect(dispatched.status).toBe(200);
    expect(dispatched.body).toEqual(await http.json());
    expect(dispatched.body.stamped).toBe(true);
    expect(dispatched.body.data[0].author.name).toBe("Ada");
    expect(dispatched.headers["content-type"]).toContain("application/json");
    // The relay request ran both stages; the dispatched one ran only the handler stage.
    expect(seen().stages).toEqual(["request /relay", "handler /relay", "handler /posts"]);
    const created = await relay(service, { method: "POST", path: "/posts", body: { title: "new", status: "draft" } });
    expect(created.status).toBe(201);
    expect(created.body.title).toBe("new");
  });

  test("keeps the caller's user, auth, tenant, ip and request id; @roles and tenant checks still apply", async () => {
    const tenancy = 'auth: {}, tenancy: { source: "config", tenants: { acme: {}, globex: {} } }';
    const service = await start(tenancy, { "entities/Payment.ts": "/** @roles finance */\nexport type Payment = { amount: number };\n", "entities/Note.ts": "export type Note = { text: string };\n" }, true);
    const caller = { "x-test-user": "u1", "x-tenant-id": "acme", "x-request-id": "req-1" };
    const who = await relay(service, { method: "GET", path: "/whoami" }, caller);
    expect(who.body).toMatchObject({ user: "u1", tenant: "acme", id: "req-1" });
    expect(typeof who.body.ip).toBe("string");
    expect((await relay(service, { method: "GET", path: "/payments" }, caller)).status).toBe(403);
    expect((await relay(service, { method: "GET", path: "/payments" }, { ...caller, "x-test-user": "u2;roles=finance" })).status).toBe(200);
    // The dispatched request does not resolve a tenant again: the caller's header stays the only source.
    await relay(service, { method: "POST", path: "/notes", body: { text: "for acme" } }, caller);
    expect((await relay(service, { method: "GET", path: "/notes" }, caller)).body.total).toBe(1);
    expect((await relay(service, { method: "GET", path: "/notes" }, { ...caller, "x-tenant-id": "globex" })).body.total).toBe(0);
    // Outside requests, a plain object gives the identity; a route needing a tenant refuses a call without one.
    const outside = await dispatchRoute({ user: { id: "u9", roles: ["finance"], claims: {} }, tenant: { id: "acme" } as never, ip: "10.0.0.9" }, { method: "GET", path: "/whoami" });
    expect(outside.body).toMatchObject({ user: "u9", tenant: "acme", ip: "10.0.0.9" });
    expect((await dispatchRoute({ user: { id: "u9", roles: ["finance"], claims: {} } }, { method: "GET", path: "/notes" })).status).toBe(400);
  });

  test("errors come back as status and error body, never thrown", async () => {
    const service = await start("", {
      "entities/Post.ts": "/** @guard */\nexport type Post = { title: string };\n",
      "hooks/guard.ts": 'import { definePreHook, HttpError } from "@quickservicets/core";\nexport default definePreHook(() => { throw new HttpError(403, "No"); });\n',
    });
    const refused = await relay(service, { method: "GET", path: "/posts" });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: { code: "FORBIDDEN", message: "No" } });
    const missing = await relay(service, { method: "GET", path: "/nowhere" });
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect((await dispatchRoute({}, { method: "DELETE", path: "/whoami" })).status).toBe(405);
  });
});
