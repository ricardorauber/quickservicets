import { describe, expect, test } from "bun:test";
import { startTestService, type TestService } from "@quickservice/cli/testing";
import { SCALAR_URL } from "@quickservice/core";
import { DEFAULT_DOCS_CSP } from "../../../core/src/features/security/headers.ts";

const CONFIG = (keys = "") => `import { defineConfig, memoryAdapter } from "@quickservice/core";
export default defineConfig({ database: memoryAdapter()${keys ? `, ${keys}` : ""} });
`;
const POST = "export type Post = { title: string };\n";
const API_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
};

async function withService(files: Record<string, string>, run: (service: TestService) => Promise<void>, env?: Record<string, string>): Promise<void> {
  const service = await startTestService({ files: { "entities/Post.ts": POST, ...files }, ...(env ? { env } : {}) });
  try {
    await run(service);
  } finally {
    await service.stop();
  }
}

const headersOf = (response: Response, names: readonly string[]) => Object.fromEntries(names.map((name) => [name, response.headers.get(name)]));

describe("default headers", () => {
  test("success, not-found and error responses carry the API headers", async () => {
    const failing = `import type { Endpoint } from "@quickservice/core";\nconst handler: Endpoint = () => { throw new Error("boom"); };\nexport default handler;\n`;
    await withService({ "quickservice.config.ts": CONFIG(), "endpoints/fail/get.ts": failing }, async (service) => {
      for (const [path, status] of [["/posts", 200], ["/nowhere", 404], ["/fail", 500]] as const) {
        const response = await service.fetch(path);
        expect(response.status).toBe(status);
        expect(headersOf(response, Object.keys(API_HEADERS))).toEqual(API_HEADERS);
      }
      expect((await service.fetch("/posts")).headers.get("strict-transport-security")).toBeNull();
    });
  });
});

describe("docs policy", () => {
  test("GET /docs carries the docs policy, which allows every script and stylesheet the page references", async () => {
    await withService({ "quickservice.config.ts": CONFIG() }, async (service) => {
      const response = await service.fetch("/docs");
      const policy = response.headers.get("content-security-policy")!;
      expect(policy).toBe(DEFAULT_DOCS_CSP);
      const directives = new Map(policy.split(";").map((part) => part.trim().split(/\s+/)).map(([name, ...sources]) => [name!, sources]));
      const allows = (directive: string, url: string) => {
        const sources = directives.get(directive) ?? directives.get("default-src") ?? [];
        const { origin } = new URL(url, "http://localhost");
        return sources.some((source) => source === origin || (source === "'self'" && origin === "http://localhost"));
      };
      const html = await response.text();
      const scripts = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((match) => match[1]!);
      const styles = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((match) => match[1]!);
      expect(scripts).toEqual([SCALAR_URL]);
      for (const source of scripts) expect(allows("script-src", source)).toBe(true);
      for (const source of styles) expect(allows("style-src", source)).toBe(true);
      // The page reads the OpenAPI document from the service itself.
      expect(html).toContain('data-url="/openapi.json"');
      expect(allows("connect-src", "/openapi.json")).toBe(true);
    });
  });
});

describe("HSTS", () => {
  const hstsOf = async (keys: string): Promise<string | null> => {
    let value = null as string | null;
    await withService({ "quickservice.config.ts": CONFIG(keys) }, async (service) => {
      value = (await service.fetch("/posts")).headers.get("strict-transport-security");
    });
    return value;
  };

  test("production sends it with includeSubDomains; preload is opt-in; hsts: false and development send none", async () => {
    expect(await hstsOf("production: true")).toBe("max-age=31536000; includeSubDomains");
    expect(await hstsOf("production: true, security: { headers: { hsts: { preload: true } } }")).toBe("max-age=31536000; includeSubDomains; preload");
    expect(await hstsOf("production: true, security: { headers: { hsts: false } }")).toBeNull();
    expect(await hstsOf("")).toBeNull();
  });
});

describe("existing headers, empty options and the tag", () => {
  test("a handler's own header wins, and an empty option leaves its header out", async () => {
    const own = `import type { Endpoint } from "@quickservice/core";\nconst handler: Endpoint = (_repos, _req, res) => { res.header("content-security-policy", "default-src 'self'"); return { ok: true }; };\nexport default handler;\n`;
    await withService({ "quickservice.config.ts": CONFIG('security: { headers: { referrerPolicy: "" } }'), "endpoints/page/get.ts": own }, async (service) => {
      const response = await service.fetch("/page");
      expect(response.headers.get("content-security-policy")).toBe("default-src 'self'");
      expect(response.headers.get("referrer-policy")).toBeNull();
      expect(response.headers.get("x-frame-options")).toBe("DENY");
    });
  });

  test("@securityHeaders off sends none of them on that route, and csp= replaces the policy there only", async () => {
    const endpoint = (tag: string) => `import type { Endpoint } from "@quickservice/core";\n/** ${tag} */\nconst handler: Endpoint = () => ({ ok: true });\nexport default handler;\n`;
    const files = {
      "quickservice.config.ts": CONFIG(),
      "endpoints/embed/get.ts": endpoint("@securityHeaders off"),
      "endpoints/widget/get.ts": endpoint(`@securityHeaders csp="default-src 'self'"`),
    };
    await withService(files, async (service) => {
      const embed = await service.fetch("/embed");
      expect(headersOf(embed, Object.keys(API_HEADERS))).toEqual(Object.fromEntries(Object.keys(API_HEADERS).map((name) => [name, null])));
      const widget = await service.fetch("/widget");
      expect(widget.headers.get("content-security-policy")).toBe("default-src 'self'");
      expect(widget.headers.get("x-frame-options")).toBe("DENY");
      expect((await service.fetch("/posts")).headers.get("content-security-policy")).toBe(API_HEADERS["content-security-policy"]);
    });
  });

  test("a returned Response with immutable headers still gets them", async () => {
    // Like a response from fetch() in runtimes that guard its headers: every change throws.
    const immutable = `import type { Endpoint } from "@quickservice/core";
const handler: Endpoint = () => {
  const response = new Response(null, { status: 302, headers: { location: "https://example.com/" } });
  const headers = response.headers;
  const locked = new Proxy(headers, { get: (target, name) => (name === "set" || name === "append" ? () => { throw new TypeError("immutable"); } : typeof Reflect.get(target, name) === "function" ? Reflect.get(target, name).bind(target) : Reflect.get(target, name)) });
  Object.defineProperty(response, "headers", { value: locked });
  return response;
};
export default handler;
`;
    await withService({ "quickservice.config.ts": CONFIG(), "endpoints/away/get.ts": immutable }, async (service) => {
      const response = await service.fetch("/away");
      expect(response.status).toBe(302);
      expect(headersOf(response, Object.keys(API_HEADERS))).toEqual(API_HEADERS);
    });
  });
});
