import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestService, type TestService } from "@quickservice/cli/testing";

const CONFIG = (security = "", extra = "") => `import { defineConfig, memoryAdapter } from "@quickservice/core";
export default defineConfig({ database: memoryAdapter()${security ? `, security: ${security}` : ""}${extra ? `, ${extra}` : ""} });
`;
const POST = "export type Post = { title: string };\n";
const endpoint = (tag: string) => `import type { Endpoint } from "@quickservice/core";\n/** ${tag} */\nconst handler: Endpoint = () => ({ ok: true });\nexport default handler;\n`;
/** A project feature whose handler middleware signs in the user and tenant named by headers. */
const AUTH = `import { defineFeature } from "@quickservice/core";
export default defineFeature({
  key: "auth",
  middleware: [{ stage: "handler", run(req, _res, next) {
    const user = req.headers.get("x-user");
    const tenant = req.headers.get("x-tenant");
    if (user) req.user = { id: user } as never;
    if (tenant) req.tenant = { id: tenant } as never;
    return next();
  } }],
});
`;

async function withService(files: Record<string, string>, run: (service: TestService) => Promise<void>): Promise<void> {
  const service = await startTestService({ files: { "entities/Post.ts": POST, ...files } });
  try {
    await run(service);
  } finally {
    await service.stop();
  }
}

const buildError = (files: Record<string, string>) =>
  startTestService({ files: { "entities/Post.ts": POST, ...files } }).then(
    (service) => service.stop().then(() => "built"),
    (error: Error) => error.message,
  );

const statuses = async (service: TestService, count: number, path: string, init?: RequestInit & { peer?: string }) => {
  const result: number[] = [];
  for (let index = 0; index < count; index++) result.push((await service.fetch(path, init)).status);
  return result;
};

describe("the tag", () => {
  test("@rateLimit 2/min on a login endpoint refuses the third login while GET /posts still passes", async () => {
    await withService({ "quickservice.config.ts": CONFIG(), "endpoints/login/post.ts": endpoint("@rateLimit 2/min") }, async (service) => {
      expect(await statuses(service, 3, "/login", { method: "POST", peer: "203.0.113.5" })).toEqual([200, 200, 429]);
      expect((await service.fetch("/posts", { peer: "203.0.113.5" })).status).toBe(200);
    });
  });

  test("an invalid rate fails the build; @rateLimit off lets 2000 requests a minute through", async () => {
    expect(await buildError({ "quickservice.config.ts": CONFIG(), "endpoints/login/post.ts": endpoint("@rateLimit limit=soon") })).toContain("invalid @rateLimit");
    await withService({ "quickservice.config.ts": CONFIG(), "endpoints/webhooks/post.ts": endpoint("@rateLimit off") }, async (service) => {
      const results = await statuses(service, 2000, "/webhooks", { method: "POST", peer: "203.0.113.5" });
      expect(results.every((status) => status === 200)).toBe(true);
      const last = await service.fetch("/webhooks", { method: "POST", peer: "203.0.113.5" });
      expect(last.headers.get("ratelimit-limit")).toBeNull();
    });
  });
});

describe("entities and endpoints", () => {
  test("an entity's tag limits each of its routes separately, and an endpoint's own tag wins", async () => {
    const files = {
      "quickservice.config.ts": CONFIG(),
      "entities/Post.ts": "/** @rateLimit 5/min */\nexport type Post = { title: string };\n",
      "entities/Note.ts": "/** @rateLimit 5/min */\nexport type Note = { text: string };\n",
      "endpoints/notes/get.ts": endpoint("@rateLimit 50/min"),
    };
    const service = await startTestService({ files });
    try {
      const create = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Hi" }), peer: "203.0.113.5" };
      expect(await statuses(service, 6, "/posts", { peer: "203.0.113.5" })).toEqual([200, 200, 200, 200, 200, 429]);
      expect(await statuses(service, 6, "/posts", create)).toEqual([201, 201, 201, 201, 201, 429]);
      const notes = await statuses(service, 6, "/notes", { peer: "203.0.113.5" });
      expect(notes.every((status) => status === 200)).toBe(true);
      expect((await service.fetch("/notes", { peer: "203.0.113.5" })).headers.get("ratelimit-limit")).toBe("50");
    } finally {
      await service.stop();
    }
  });
});

describe("combined buckets", () => {
  test("with a global 3/min and a route 10/min, the route's responses show the global bucket once it is lower", async () => {
    await withService({ "quickservice.config.ts": CONFIG('{ rateLimit: { limit: "3/min" } }'), "endpoints/search/get.ts": endpoint("@rateLimit 10/min") }, async (service) => {
      const first = await service.fetch("/search", { peer: "203.0.113.5" });
      expect([first.headers.get("ratelimit-limit"), first.headers.get("ratelimit-remaining")]).toEqual(["3", "2"]);
      await service.fetch("/search", { peer: "203.0.113.5" });
      const third = await service.fetch("/search", { peer: "203.0.113.5" });
      expect([third.headers.get("ratelimit-limit"), third.headers.get("ratelimit-remaining")]).toEqual(["3", "0"]);
      const fourth = await service.fetch("/search", { peer: "203.0.113.5" });
      expect(fourth.status).toBe(429);
      expect(fourth.headers.get("ratelimit-limit")).toBe("3");
    });
  });
});

describe("user and tenant keys", () => {
  test("by=user shares one budget across a user's addresses, and anonymous requests count per address", async () => {
    const files = { "quickservice.config.ts": CONFIG("", "auth: {}"), "features/auth/index.ts": AUTH, "endpoints/reports/get.ts": endpoint("@rateLimit limit=2/min by=user") };
    await withService(files, async (service) => {
      const asUser = (peer: string) => service.fetch("/reports", { peer, headers: { "x-user": "u1" } });
      expect([(await asUser("203.0.113.5")).status, (await asUser("198.51.100.7")).status, (await asUser("198.51.100.8")).status]).toEqual([200, 200, 429]);
      expect(await statuses(service, 3, "/reports", { peer: "203.0.113.9" })).toEqual([200, 200, 429]);
      expect((await service.fetch("/reports", { peer: "203.0.113.10" })).status).toBe(200);
      // A tenant key works the same way.
    });
    const tenantFiles = { "quickservice.config.ts": CONFIG('{ rateLimit: { limit: "2/min", by: ["tenant"] } }', "auth: {}"), "features/auth/index.ts": AUTH };
    await withService(tenantFiles, async (service) => {
      const asTenant = (peer: string) => service.fetch("/posts", { peer, headers: { "x-tenant": "acme" } });
      expect([(await asTenant("203.0.113.5")).status, (await asTenant("198.51.100.7")).status, (await asTenant("198.51.100.8")).status]).toEqual([200, 200, 429]);
    });
  });
});

describe("per-request limits", () => {
  test("a function of the user gives each user its limit, and an invalid result fails the request with 500", async () => {
    const limit = '{ rateLimit: { limit: ({ user }) => ((user as { id?: string } | undefined)?.id === "vip" ? "100/min" : "2/min") } }';
    await withService({ "quickservice.config.ts": CONFIG(limit, "auth: {}"), "features/auth/index.ts": AUTH }, async (service) => {
      expect(await statuses(service, 3, "/posts", { peer: "203.0.113.5", headers: { "x-user": "u1" } })).toEqual([200, 200, 429]);
      expect(await statuses(service, 3, "/posts", { peer: "203.0.113.5", headers: { "x-user": "vip" } })).toEqual([200, 200, 200]);
    });
    await withService({ "quickservice.config.ts": CONFIG('{ rateLimit: { limit: () => "lots" } }') }, async (service) => {
      const failed = await service.fetch("/posts", { peer: "203.0.113.5" });
      expect(failed.status).toBe(500);
      expect(JSON.stringify(await failed.json())).toContain("security.rateLimit.limit");
    });
  });
});

describe("reference", () => {
  test("the security page lists @rateLimit with its shorthand and example", () => {
    const page = readFileSync(join(import.meta.dir, "../../../../docs/src/content/docs/reference/features/security.mdx"), "utf8");
    expect(page).toContain("### `@rateLimit`");
    expect(page).toContain("`@rateLimit <limit> [by=…]`");
    expect(page).toContain("@rateLimit 10/min by=user");
  });
});
