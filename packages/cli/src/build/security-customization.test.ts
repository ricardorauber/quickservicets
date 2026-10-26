import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createFeatureLifecycle, memoryAdapter, memoryRateLimitStore, resolveConfig, type LogEntry, type ServiceConfig } from "@quickservicets/core";
import { SECURITY_ITEMS } from "../../../core/src/features/security/pipeline.ts";
import { eject } from "../eject/eject.ts";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService, type TestService } from "../testing/service.ts";

/** What the projects' config and features record, read by the tests. */
const SINK = "__securityCustomization";
const sink = () => ((globalThis as Record<string, unknown>)[SINK] ??= { logs: [], limited: [], hits: [] }) as { logs: LogEntry[]; limited: unknown[]; hits: string[] };
afterEach(() => {
  delete (globalThis as Record<string, unknown>)[SINK];
});

const CONFIG = (keys = "") => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
const sink = ((globalThis as Record<string, unknown>).${SINK} ??= { logs: [], limited: [], hits: [] }) as { logs: unknown[]; limited: unknown[]; hits: string[] };
const write = (entry: unknown) => void sink.logs.push(entry);
export default defineConfig({ database: memoryAdapter(), logger: { info: write, warn: write, error: write }${keys ? `, ${keys}` : ""} });
`;
const POST = { "entities/Post.ts": "export type Post = { title: string };\n" };
const endpoint = (tag = "") => `import type { Endpoint } from "@quickservicets/core";\n${tag ? `/** ${tag} */\n` : ""}const handler: Endpoint = async (_repos, req) => ({ size: JSON.stringify(await req.json()).length });\nexport default handler;\n`;
const STORE_FEATURE = (key: string) => `import { defineFeature, memoryRateLimitStore } from "@quickservicets/core";
export default defineFeature({
  key: "${key}",
  after: ["security"],
  setup(ctx) {
    const sink = ((globalThis as Record<string, unknown>).${SINK} ??= { logs: [], limited: [], hits: [] }) as { hits: string[] };
    const store = memoryRateLimitStore();
    ctx.feature("security").rateLimitStore({ hit: (key, hit) => (sink.hits.push("${key}:" + key), store.hit(key, hit)), reset: (key) => store.reset(key) });
  },
});
`;

async function withService(files: Record<string, string>, run: (service: TestService) => Promise<void>, env?: Record<string, string>): Promise<void> {
  const service = await startTestService({ files: { ...POST, ...files }, ...(env ? { env } : {}) });
  try {
    await run(service);
  } finally {
    await service.stop();
  }
}
const startupError = (files: Record<string, string>) =>
  startTestService({ files: { ...POST, ...files } }).then(
    (service) => service.stop().then(() => "started"),
    (error: Error) => error.message,
  );
const preflight = (service: TestService, origin: string, headers: Record<string, string> = {}) =>
  service.fetch("/posts", { method: "OPTIONS", headers: { origin, "access-control-request-method": "GET", ...headers } });

describe("environment variables", () => {
  test("rate limit, CORS origins and the headers switch change the behavior over a config that sets other values", async () => {
    const config = CONFIG('security: { rateLimit: { limit: "100/min" }, cors: { origins: ["https://c.example"] }, headers: { referrerPolicy: "same-origin" } }');
    const env = { QS_SECURITY_RATE_LIMIT_LIMIT: "2/min", QS_SECURITY_CORS_ORIGINS: "https://a.example,https://b.example", QS_SECURITY_HEADERS_ENABLED: "false" };
    await withService(
      { "quickservicets.config.ts": config },
      async (service) => {
        const first = await service.fetch("/posts", { peer: "203.0.113.5" });
        expect(first.headers.get("ratelimit-limit")).toBe("2");
        expect(first.headers.get("referrer-policy")).toBeNull();
        expect(first.headers.get("x-content-type-options")).toBeNull();
        expect((await preflight(service, "https://b.example", {})).status).toBe(204);
        expect((await preflight(service, "https://c.example", {})).status).toBe(403);
      },
      env,
    );
  });

  test("every item has its switch and every option its variable", () => {
    for (const item of SECURITY_ITEMS) {
      const name = `QS_SECURITY_${item.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}_ENABLED`;
      const config = resolveConfig({ database: memoryAdapter() } as ServiceConfig, { [name]: "false" });
      expect((config.features.find((feature) => feature.key === "security")!.options[item] as { enabled: boolean }).enabled).toBe(false);
    }
    const resolved = resolveConfig({ database: memoryAdapter() } as ServiceConfig, {
      QS_SECURITY_RATE_LIMIT_BY: "user,route",
      QS_SECURITY_PROXY_TRUST: "10.0.0.0/8,loopback",
      QS_SECURITY_LIMITS_BODY: "2MB",
      QS_SECURITY_HEADERS_CSP: "default-src 'self'",
      QS_SECURITY_IP_ALLOW: "10.0.0.0/8",
      QS_SECURITY_RATE_LIMIT_STORE: "database",
    });
    const options = resolved.features.find((feature) => feature.key === "security")!.options as Record<string, Record<string, unknown>>;
    expect(options.rateLimit!.by).toEqual(["user", "route"]);
    expect(options.rateLimit!.store).toBe("database");
    expect(options.proxy!.trust).toEqual(["10.0.0.0/8", "loopback"]);
    expect(options.limits!.body).toBe("2MB");
    expect(options.headers!.csp).toBe("default-src 'self'");
    expect(options.ip!.allow).toEqual(["10.0.0.0/8"]);
  });
});

describe("@limits", () => {
  test("a route's body limit, with the global one elsewhere, and the server body size", async () => {
    const big = JSON.stringify({ data: "x".repeat(10 * 1024 * 1024) });
    const files = { "quickservicets.config.ts": CONFIG(), "endpoints/imports/post.ts": endpoint("@limits body=20MB"), "endpoints/notes/post.ts": endpoint() };
    await withService(files, async (service) => {
      const json = { method: "POST", headers: { "content-type": "application/json", "content-length": String(big.length) }, body: big };
      expect((await service.fetch("/imports", json)).status).toBe(200);
      expect((await service.fetch("/notes", json)).status).toBe(413);
    });
    const config = resolveConfig({ database: memoryAdapter(), logger: { info() {}, warn() {}, error() {} } } as ServiceConfig, {});
    const lifecycle = createFeatureLifecycle({
      features: config.features,
      config,
      models: [],
      worker: { index: 0, count: 1, runsScheduledWork: true },
      endpoints: [{ method: "POST", path: "/imports", tags: { limits: { on: true, options: { body: "20MB" } } } }],
    });
    await lifecycle.setup();
    expect(lifecycle.server.maxRequestBodySize).toBe(20 * 1024 * 1024);
  });
});

describe("per-request origins", () => {
  test("a function of the request decides the allowed origins", async () => {
    const config = CONFIG('security: { cors: { origins: ({ req }) => (req?.headers.get("x-tenant") === "acme" ? ["https://acme.example"] : []) } }');
    await withService({ "quickservicets.config.ts": config }, async (service) => {
      expect((await preflight(service, "https://acme.example", { "x-tenant": "acme" })).status).toBe(204);
      expect((await preflight(service, "https://acme.example", { "x-tenant": "other" })).status).toBe(403);
      const read = await service.fetch("/posts", { headers: { origin: "https://acme.example", "x-tenant": "acme" } });
      expect(read.headers.get("access-control-allow-origin")).toBe("https://acme.example");
    });
  });
});

describe("hooks", () => {
  test("onLimited records the key and limit of a 429; a throwing onBlocked is logged and the 403 is still sent", async () => {
    const config = CONFIG(`security: {
      rateLimit: { limit: "1/min", onLimited: (refusal) => void sink.limited.push({ key: refusal.key, limit: refusal.limit, item: refusal.item, reason: refusal.reason, route: refusal.route, ip: refusal.ip }) },
      ip: { deny: ["198.51.100.0/24"], onBlocked: () => { throw new Error("hook broke"); } },
    }`);
    await withService({ "quickservicets.config.ts": config }, async (service) => {
      expect((await service.fetch("/posts", { peer: "203.0.113.5" })).status).toBe(200);
      expect((await service.fetch("/posts", { peer: "203.0.113.5" })).status).toBe(429);
      expect(sink().limited).toEqual([{ key: "203.0.113.5", limit: "1/min", item: "rateLimit", reason: "Too many requests", route: "GET /posts", ip: "203.0.113.5" }]);
      const blocked = await service.fetch("/posts", { peer: "198.51.100.7" });
      expect(blocked.status).toBe(403);
      await Bun.sleep(1);
      expect(sink().logs.find((entry) => entry.message === "feature.hook.failed")).toMatchObject({ feature: "security", hook: "ip.onBlocked", error: { message: "hook broke" } });
    });
  });
});

describe("providers", () => {
  test("a store in the config receives every hit; a feature's store replaces the memory store; both fail startup", async () => {
    const config = CONFIG(`security: { rateLimit: { store: { hit: (key, hit) => (sink.hits.push("config:" + key), { allowed: true, limit: hit.limit, remaining: hit.limit, resetMs: 1000, retryAfterMs: 0 }), reset() {} } } }`);
    await withService({ "quickservicets.config.ts": config }, async (service) => {
      await service.fetch("/posts", { peer: "203.0.113.5" });
      await service.fetch("/posts", { peer: "203.0.113.6" });
      expect(sink().hits).toEqual(["config:203.0.113.5", "config:203.0.113.6"]);
    });
    sink().hits.length = 0;
    await withService({ "quickservicets.config.ts": CONFIG("redisish: {}"), "features/redisish/index.ts": STORE_FEATURE("redisish") }, async (service) => {
      await service.fetch("/posts", { peer: "203.0.113.5" });
      expect(sink().hits).toEqual(["redisish:203.0.113.5"]);
    });
    expect(await startupError({ "quickservicets.config.ts": config.replace("logger:", "redisish: {}, logger:"), "features/redisish/index.ts": STORE_FEATURE("redisish") })).toContain(
      "security.rateLimit.store is set by both the config and redisish",
    );
    expect(await startupError({ "quickservicets.config.ts": CONFIG("one: {}, two: {}"), "features/one/index.ts": STORE_FEATURE("one"), "features/two/index.ts": STORE_FEATURE("two") })).toContain(
      "security.rateLimit.store is set by both one and two",
    );
    expect(memoryRateLimitStore).toBeDefined();
  });

  test("a resolver reading cf-connecting-ip sets req.ip, normalized", async () => {
    const config = CONFIG('security: { proxy: { resolver: { resolve: ({ request, peer }) => request.headers.get("cf-connecting-ip") ?? peer } } }');
    const ip = `import type { Endpoint } from "@quickservicets/core";\nconst handler: Endpoint = (_repos, req) => ({ ip: req.ip });\nexport default handler;\n`;
    await withService({ "quickservicets.config.ts": config, "endpoints/ip/get.ts": ip }, async (service) => {
      expect(await (await service.fetch("/ip", { peer: "10.0.0.1", headers: { "cf-connecting-ip": "::ffff:198.51.100.23" } })).json()).toEqual({ ip: "198.51.100.23" });
      expect(await (await service.fetch("/ip", { peer: "10.0.0.1" })).json()).toEqual({ ip: "10.0.0.1" });
    });
  });
});

describe("reference", () => {
  test("the page lists the variables, the seven tags and the hooks", () => {
    const page = readFileSync(join(import.meta.dir, "../../../../docs/src/content/docs/reference/features/security.mdx"), "utf8");
    expect(page).toContain("`QS_SECURITY_RATE_LIMIT_LIMIT`");
    for (const tag of ["rateLimit", "cors", "ipAllow", "ipDeny", "securityHeaders", "limits", "sensitive"]) expect(page).toContain(`### \`@${tag}\``);
    for (const hook of ["security.rateLimit.onLimited", "security.ip.onBlocked", "security.cors.onRejected", "security.loadShedding.onShed", "security.limits.onRejected"]) expect(page).toContain(`| \`${hook}\` |`);
  });
});

describe("eject", () => {
  /** The files of a project folder, as `startTestService` takes them. */
  const filesOf = (root: string): Record<string, string> => {
    const files: Record<string, string> = {};
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      const path = relative(root, join(entry.parentPath, entry.name));
      if (!entry.isFile() || /^(node_modules|\.generated)\//.test(path) || !path.endsWith(".ts")) continue;
      files[path] = readFileSync(join(entry.parentPath, entry.name), "utf8");
    }
    return files;
  };

  test("a dry run lists features/security/ without changing the config, and the ejected feature keeps every behavior", async () => {
    const config = CONFIG('security: { rateLimit: { limit: "2/min" }, cors: { origins: ["https://app.example"] } }');
    const root = createLinkedProject({ "quickservicets.config.ts": config, ...POST });
    const planned = await eject(root, "security", { dryRun: true });
    expect(planned).toContain("Would write features/security/index.ts");
    expect(planned.every((line) => line.startsWith("Would write features/security/"))).toBe(true);
    expect(existsSync(join(root, "features/security"))).toBe(false);
    expect(readFileSync(join(root, "quickservicets.config.ts"), "utf8")).toBe(config);
    await eject(root, "security");
    expect(readFileSync(join(root, "features/security/index.ts"), "utf8")).toContain('from "@quickservicets/core"');
    await withService(filesOf(root), async (service) => {
      const first = await service.fetch("/posts", { peer: "203.0.113.5" });
      expect(first.headers.get("x-content-type-options")).toBe("nosniff");
      expect((await preflight(service, "https://app.example")).status).toBe(204);
      expect((await preflight(service, "https://evil.example")).status).toBe(403);
      await service.fetch("/posts", { peer: "203.0.113.5" });
      expect((await service.fetch("/posts", { peer: "203.0.113.5" })).status).toBe(429);
    });
  });
});
