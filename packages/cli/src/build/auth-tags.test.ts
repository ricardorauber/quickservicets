import { afterEach, describe, expect, test } from "bun:test";
import { testAuth } from "@quickservicets/core/testing";
import { startTestService, type TestService } from "../testing/service.ts";

const config = (keys = "auth: {}") => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), ${keys} });
`;

const running: TestService[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
});

async function start(files: Record<string, string>, keys?: string) {
  const service = await startTestService({ files: { "quickservicets.config.ts": config(keys), ...files }, auth: testAuth() });
  running.push(service);
  return service;
}

const as = (user: string | undefined, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}), ...((init.headers as Record<string, string>) ?? {}) },
});
const errorOf = async (response: Response) => ({ status: response.status, ...((await response.json()) as { error: { code: string; message: string } }).error });

describe("@auth", () => {
  test("@auth on an entity answers 401 with a challenge to anonymous requests and serves signed-in users", async () => {
    const service = await start({ "entities/Post.ts": "/** @auth */\nexport type Post = { title: string };\n" });
    const anonymous = await service.fetch("/posts");
    expect(await errorOf(anonymous)).toEqual({ status: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    expect(anonymous.headers.get("www-authenticate")).toBe('Test realm="test"');
    expect((await service.fetch("/posts", as("u1"))).status).toBe(200);
  });

  test("required: true protects every route but @auth off endpoints, and scopes answer 403 Insufficient scope", async () => {
    const service = await start(
      {
        "entities/Post.ts": "export type Post = { title: string };\n",
        "endpoints/signup/post.ts": 'import type { Endpoint } from "@quickservicets/core";\n/** @auth off */\nconst handler: Endpoint = () => ({ ok: true });\nexport default handler;\n',
        "endpoints/publish/post.ts": 'import type { Endpoint } from "@quickservicets/core";\n/** @auth scopes=posts:write */\nconst handler: Endpoint = () => ({ published: true });\nexport default handler;\n',
      },
      "auth: { required: true }",
    );
    expect((await service.fetch("/posts")).status).toBe(401);
    expect((await service.fetch("/signup", as(undefined, { method: "POST" }))).status).toBe(200);
    expect((await service.fetch("/posts", as("u1"))).status).toBe(200);
    const refused = await service.fetch("/publish", as("u1;scopes=posts:read", { method: "POST" }));
    expect(await errorOf(refused)).toEqual({ status: 403, code: "FORBIDDEN", message: "Insufficient scope" });
    expect(refused.headers.get("www-authenticate")).toBe('Bearer error="insufficient_scope", scope="posts:write"');
    expect((await service.fetch("/publish", as("u1;scopes=posts:read,posts:write", { method: "POST" }))).status).toBe(200);
  });
});

describe("@roles", () => {
  test("@roles admin:delete lets any user list and update, and only admins delete", async () => {
    const service = await start({ "entities/User.ts": "/** @roles admin:delete */\nexport type User = { name: string };\n" });
    const created = await service.fetch("/users", as("u1", { method: "POST", body: JSON.stringify({ name: "Ana" }) }));
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect((await service.fetch("/users", as("u1"))).status).toBe(200);
    expect((await service.fetch(`/users/${id}`, as("u1", { method: "PATCH", body: JSON.stringify({ name: "Bea" }) }))).status).toBe(200);
    expect((await service.fetch("/users")).status).toBe(200);
    expect(await errorOf(await service.fetch(`/users/${id}`, as(undefined, { method: "DELETE" })))).toMatchObject({ status: 401, message: "Authentication required" });
    expect(await errorOf(await service.fetch(`/users/${id}`, as("u1", { method: "DELETE" })))).toEqual({ status: 403, code: "FORBIDDEN", message: "Not allowed" });
    expect((await service.fetch(`/users/${id}`, as("boss;roles=admin", { method: "DELETE" }))).status).toBe(204);
  });

  test("view and write groups give viewers reads only and editors writes only", async () => {
    const service = await start({ "entities/Note.ts": "/** @roles editor:write,viewer:view */\nexport type Note = { title: string };\n" });
    const body = JSON.stringify({ title: "Plan" });
    expect((await service.fetch("/notes", as("v;roles=viewer"))).status).toBe(200);
    expect((await service.fetch("/notes", as("v;roles=viewer", { method: "POST", body }))).status).toBe(403);
    expect((await service.fetch("/notes", as("e;roles=editor", { method: "POST", body }))).status).toBe(201);
    expect((await service.fetch("/notes", as("e;roles=editor"))).status).toBe(403);
  });

  test("an unknown operation, or an operation on an endpoint, fails the build", async () => {
    await expect(start({ "entities/Doc.ts": "/** @roles admin:fly */\nexport type Doc = { title: string };\n" })).rejects.toThrow(
      "entities/Doc.ts: invalid @roles: admin:fly: unknown operation fly",
    );
    await expect(
      start({ "endpoints/report/get.ts": 'import type { Endpoint } from "@quickservicets/core";\n/** @roles admin:delete */\nconst handler: Endpoint = () => ({});\nexport default handler;\n' }),
    ).rejects.toThrow("endpoints/report/get.ts: invalid @roles: admin:delete: operations apply only to entities");
  });
});

describe("routes of other natives and endpoints", () => {
  test("@auth on an entity protects its history and change stream, and an endpoint's @auth off makes its list public", async () => {
    const service = await start(
      {
        "entities/Post.ts": "/**\n * @auth\n * @history\n * @changes\n */\nexport type Post = { title: string };\n",
        "endpoints/posts/get.ts": 'import type { Endpoint } from "@quickservicets/core";\n/** @auth off */\nconst handler: Endpoint = (repos) => repos.posts.list({ where: [], sort: [], limit: 20, offset: 0 });\nexport default handler;\n',
      },
      "auth: {}, events: {}, history: {}, realtime: {}",
    );
    const created = await service.fetch("/posts", as("u1", { method: "POST", body: JSON.stringify({ title: "Hi" }) }));
    const { id } = (await created.json()) as { id: string };
    expect((await service.fetch(`/posts/${id}/history`)).status).toBe(401);
    expect((await service.fetch(`/posts/${id}/history`, as("u1"))).status).toBe(200);
    expect((await service.fetch("/posts/changes")).status).toBe(401);
    expect((await service.fetch("/posts")).status).toBe(200);
    expect((await service.fetch(`/posts/${id}`)).status).toBe(401);
  });

  test("a hook calling requireRole answers 403 to a user without the role and passes an admin", async () => {
    const service = await start({
      "hooks/adminOnly.ts": 'import { definePreHook, requireRole } from "@quickservicets/core";\nexport default definePreHook((_repos, req) => { req.context.admin = requireRole(req, "admin").id; });\n',
      "endpoints/admin/get.ts": 'import type { Endpoint } from "@quickservicets/core";\n/** @adminOnly */\nconst handler: Endpoint = (_repos, req) => ({ admin: req.context.admin });\nexport default handler;\n',
    });
    expect(await errorOf(await service.fetch("/admin", as("u1")))).toMatchObject({ status: 403, message: "Not allowed" });
    expect(await errorOf(await service.fetch("/admin"))).toMatchObject({ status: 401, message: "Authentication required" });
    expect(await (await service.fetch("/admin", as("boss;roles=admin"))).json()).toEqual({ admin: "boss" });
  });
});
