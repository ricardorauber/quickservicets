import { describe, expect, spyOn, test } from "bun:test";
import { startTestService, type TestService } from "@quickservicets/cli/testing";
import { memoryAdapter, OriginMatcher, resolveConfig } from "@quickservicets/core";

const CONFIG = (security = "") => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter()${security ? `, security: ${security}` : ""} });
`;
const POST = "export type Post = { title: string };\n";
const endpoint = (tag = "", body = "({ ok: true })") => `import type { Endpoint } from "@quickservicets/core";\n${tag ? `/** ${tag} */\n` : ""}const handler: Endpoint = () => ${body};\nexport default handler;\n`;

async function withService(files: Record<string, string>, run: (service: TestService) => Promise<void>, env?: Record<string, string>): Promise<void> {
  const service = await startTestService({ files: { "entities/Post.ts": POST, ...files }, ...(env ? { env } : {}) });
  try {
    await run(service);
  } finally {
    await service.stop();
  }
}

const preflight = (service: TestService, path: string, origin: string, method: string, headers?: string) =>
  service.fetch(path, { method: "OPTIONS", headers: { origin, "access-control-request-method": method, ...(headers ? { "access-control-request-headers": headers } : {}) } });
const errorOf = async (response: Response) => ((await response.json()) as { error: { code: string; message: string } }).error;

describe("origin matching", () => {
  test("exact origins, *, subdomain patterns and null", () => {
    const pattern = new OriginMatcher(["https://*.example.com"]);
    expect(pattern.allows("https://a.b.example.com")).toBe(true);
    expect(pattern.allows("https://a.example.com")).toBe(true);
    expect(pattern.allows("http://a.example.com")).toBe(false);
    expect(pattern.allows("https://example.com")).toBe(false);
    expect(pattern.allows("https://a.example.com.evil.dev")).toBe(false);
    expect(pattern.allows("null")).toBe(false);
    expect(new OriginMatcher(["null"]).allows("null")).toBe(true);
    expect(new OriginMatcher(["*"]).allows("null")).toBe(false);
    expect(new OriginMatcher(["*"]).allows("https://any.dev")).toBe(true);
    expect(new OriginMatcher(["https://app.example.com"]).allows("https://app.example.com:8443")).toBe(false);
    expect(new OriginMatcher(["https://App.Example.com"]).allows("https://app.example.com")).toBe(true);
    expect(new OriginMatcher([]).allows("https://app.example.com")).toBe(false);
  });
});

describe("configuration errors", () => {
  const failure = (cors: Record<string, unknown>) => {
    try {
      resolveConfig({ database: memoryAdapter(), security: { cors } } as never, {});
    } catch (error) {
      return (error as Error).message;
    }
    return "no error";
  };

  test("credentials with *, and entries that are not origins", () => {
    expect(failure({ credentials: true, origins: ["*"] })).toBe('Invalid security.cors: credentials cannot be used with origins "*"');
    expect(failure({ origins: ["app.example.com"] })).toBe("Invalid security.cors.origins[0]: expected an origin like https://app.example.com");
    expect(failure({ origins: ["https://ok.example", "https://*.example.com", "null", "*", "http://localhost:5173"] })).toBe("no error");
  });
});

describe("preflights", () => {
  test("defaults refuse every origin; a GET from it proceeds without CORS headers", async () => {
    await withService({ "quickservicets.config.ts": CONFIG() }, async (service) => {
      const refused = await preflight(service, "/posts", "https://evil.example", "GET");
      expect(refused.status).toBe(403);
      expect(await errorOf(refused)).toEqual({ code: "FORBIDDEN", message: "Origin not allowed" });
      const read = await service.fetch("/posts", { headers: { origin: "https://evil.example" } });
      expect(read.status).toBe(200);
      expect(read.headers.get("access-control-allow-origin")).toBeNull();
    });
  });

  test("an allowed origin gets 204 with the preflight headers, and its requests get the CORS headers", async () => {
    await withService({ "quickservicets.config.ts": CONFIG('{ cors: { origins: ["https://app.example.com"] } }') }, async (service) => {
      const answer = await preflight(service, "/posts/123", "https://app.example.com", "PATCH", "Content-Type");
      expect(answer.status).toBe(204);
      expect(Object.fromEntries(["access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers", "access-control-max-age", "access-control-allow-credentials", "vary"].map((name) => [name, answer.headers.get(name)]))).toEqual({
        "access-control-allow-origin": "https://app.example.com",
        "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE",
        "access-control-allow-headers": "content-type, authorization, idempotency-key, if-match, if-none-match, x-request-id",
        "access-control-max-age": "600",
        "access-control-allow-credentials": null,
        vary: "Origin",
      });
      const read = await service.fetch("/posts", { headers: { origin: "https://app.example.com" } });
      expect(read.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
      expect(read.headers.get("access-control-expose-headers")).toBe("x-request-id, etag, location, retry-after, ratelimit-limit, ratelimit-remaining, ratelimit-reset");
      expect(read.headers.get("vary")).toBe("Origin");
    });
  });

  test("a header or a method outside the lists is refused", async () => {
    await withService({ "quickservicets.config.ts": CONFIG('{ cors: { origins: ["https://app.example.com"], credentials: true } }') }, async (service) => {
      const header = await preflight(service, "/posts", "https://app.example.com", "POST", "content-type, X-Secret");
      expect(header.status).toBe(403);
      expect((await errorOf(header)).message).toBe("Header not allowed by CORS: x-secret");
      const method = await preflight(service, "/posts", "https://app.example.com", "TRACE");
      expect(method.status).toBe(403);
      expect((await errorOf(method)).message).toBe("Method not allowed by CORS");
      const ok = await preflight(service, "/posts", "https://app.example.com", "POST");
      expect(ok.headers.get("access-control-allow-credentials")).toBe("true");
    });
  });

  test("cors: false and QS_SECURITY_CORS_ENABLED=false leave preflights to routing while the other items act", async () => {
    for (const [security, env] of [["{ cors: false }", undefined], ["", { QS_SECURITY_CORS_ENABLED: "false" }]] as const) {
      await withService(
        { "quickservicets.config.ts": CONFIG(security) },
        async (service) => {
          const response = await preflight(service, "/posts", "https://evil.example", "GET");
          expect(response.status).toBe(405);
          expect(response.headers.get("access-control-allow-origin")).toBeNull();
          expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        },
        env,
      );
    }
  });
});

describe("requests", () => {
  test("Vary keeps the handler's value, and a request without Origin never reaches the matcher", async () => {
    const files = { "quickservicets.config.ts": CONFIG('{ cors: { origins: ["https://app.example.com"] } }'), "endpoints/varied/get.ts": endpoint("", 'new Response("{}", { headers: { vary: "Accept" } })') };
    await withService(files, async (service) => {
      const varied = await service.fetch("/varied", { headers: { origin: "https://app.example.com" } });
      expect(varied.headers.get("vary")).toBe("Accept, Origin");
      const spy = spyOn(OriginMatcher.prototype, "allows");
      try {
        const plain = await service.fetch("/posts");
        expect(plain.headers.get("access-control-allow-origin")).toBeNull();
        expect(plain.headers.get("vary")).toBeNull();
        expect(spy).not.toHaveBeenCalled();
        await service.fetch("/posts", { headers: { origin: "https://app.example.com" } });
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("route tags and own OPTIONS endpoints", () => {
  test("@cors allows its origin on that route only, @cors off turns it off, and options.ts answers its own preflight", async () => {
    const files = {
      "quickservicets.config.ts": CONFIG(),
      "endpoints/partner/orders/get.ts": endpoint("@cors origins=https://partner.example credentials=true"),
      "endpoints/internal/get.ts": endpoint("@cors off"),
      "endpoints/x/get.ts": endpoint(),
      "endpoints/x/options.ts": endpoint("", 'new Response(null, { status: 200, headers: { "x-own": "yes" } })'),
    };
    await withService(files, async (service) => {
      const partner = await preflight(service, "/partner/orders", "https://partner.example", "GET");
      expect(partner.status).toBe(204);
      expect(partner.headers.get("access-control-allow-credentials")).toBe("true");
      const read = await service.fetch("/partner/orders", { headers: { origin: "https://partner.example" } });
      expect(read.headers.get("access-control-allow-origin")).toBe("https://partner.example");
      expect((await preflight(service, "/posts", "https://partner.example", "GET")).status).toBe(403);
      expect((await service.fetch("/posts", { headers: { origin: "https://partner.example" } })).headers.get("access-control-allow-origin")).toBeNull();
      // With CORS off, the preflight reaches routing, which has no OPTIONS route there.
      expect((await preflight(service, "/internal", "https://partner.example", "GET")).status).toBe(405);
      const own = await preflight(service, "/x", "https://evil.example", "GET");
      expect(own.status).toBe(200);
      expect(own.headers.get("x-own")).toBe("yes");
    });
  });

  test("a tag with credentials and * fails startup", async () => {
    const files = { "quickservicets.config.ts": CONFIG(), "endpoints/open/get.ts": endpoint('@cors origins=* credentials=true') };
    const error = await startTestService({ files: { "entities/Post.ts": POST, ...files } }).then(
      (service) => service.stop().then(() => "started"),
      (failure: Error) => failure.message,
    );
    expect(error).toContain('Invalid @cors of GET /open: credentials cannot be used with origins "*"');
  });
});
