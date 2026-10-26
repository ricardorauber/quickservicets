import { describe, expect, spyOn, test } from "bun:test";
import { startTestService, type TestService } from "@quickservicets/cli/testing";
import { createServer, memoryAdapter, resolveConfig, createFeatureLifecycle, type ServiceConfig } from "@quickservicets/core";
import { headersWithinLimits, pathAndQueryLength } from "../../../core/src/features/security/limits.ts";
import { parseProjectEntities } from "../entities/parse-entities.ts";
import { createProject } from "../testing/project.ts";

const CONFIG = (security = "") => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter()${security ? `, security: ${security}` : ""} });
`;
const POST = "export type Post = { title: string; body?: string };\n";
const errorOf = async (response: Response) => ((await response.json()) as { error: { code: string; message: string } }).error;

async function withService(files: Record<string, string>, run: (service: TestService) => Promise<void>, env?: Record<string, string>): Promise<void> {
  const service = await startTestService({ files: { "entities/Post.ts": POST, ...files }, ...(env ? { env } : {}) });
  try {
    await run(service);
  } finally {
    await service.stop();
  }
}

/** A JSON body streamed in chunks without content-length; `pulled` counts the bytes the server asked for. */
function streamedJson(size: number, chunk = 64 * 1024) {
  const text = JSON.stringify({ title: "x".repeat(Math.max(0, size - 13)) });
  const bytes = new TextEncoder().encode(text);
  const state = { pulled: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= bytes.length) return controller.close();
      const next = bytes.subarray(state.pulled, state.pulled + chunk);
      state.pulled += next.length;
      controller.enqueue(next);
    },
  });
  return { init: { method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half" } as RequestInit, state };
}

describe("URL and header checks", () => {
  test("a long query string, too many headers and one large header are refused", async () => {
    const ping = `import type { Endpoint } from "@quickservicets/core";\nconst handler: Endpoint = () => ({ ok: true });\nexport default handler;\n`;
    await withService({ "quickservicets.config.ts": CONFIG(), "endpoints/ping/get.ts": ping }, async (service) => {
      const long = await service.fetch(`/ping?q=${"a".repeat(9 * 1024)}`);
      expect(long.status).toBe(414);
      expect(await errorOf(long)).toEqual({ code: "URI_TOO_LONG", message: "URL is too long" });
      // Exactly at the limit passes: 8KB of path and query.
      expect((await service.fetch(`/ping?q=${"a".repeat(8 * 1024 - "/ping?q=".length)}`)).status).toBe(200);
      expect((await service.fetch(`/ping?q=${"a".repeat(8 * 1024 - "/ping?q=".length + 1)}`)).status).toBe(414);
      const many = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`x-h${index}`, "1"]));
      const crowded = await service.fetch("/posts", { headers: many });
      expect(crowded.status).toBe(431);
      expect(await errorOf(crowded)).toEqual({ code: "REQUEST_HEADER_FIELDS_TOO_LARGE", message: "Request headers are too large" });
      expect((await service.fetch("/posts", { headers: { "x-big": "b".repeat(20 * 1024) } })).status).toBe(431);
      expect((await service.fetch("/posts", { headers: { "x-ok": "b".repeat(10 * 1024) } })).status).toBe(200);
    });
  });

  test("one pass over the headers the request holds, without copying them", () => {
    const real = new Headers({ a: "1", bb: "22" });
    let passes = 0;
    let copies = 0;
    const spied = new Proxy(real, {
      get(target, name) {
        if (name === "forEach") return (fn: (value: string, key: string) => void) => (passes++, target.forEach(fn));
        if (name === "entries" || name === Symbol.iterator || name === "keys" || name === "values") copies++;
        const value = Reflect.get(target, name);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(headersWithinLimits(spied, 6, 2)).toBe(true);
    expect(headersWithinLimits(spied, 5, 2)).toBe(false);
    expect(headersWithinLimits(spied, 100, 1)).toBe(false);
    expect(passes).toBe(3);
    expect(copies).toBe(0);
    expect(pathAndQueryLength("http://localhost:3000/posts?x=1")).toBe("/posts?x=1".length);
  });
});

describe("body limits", () => {
  test("a declared length above the limit is refused before any read", async () => {
    await withService({ "quickservicets.config.ts": CONFIG() }, async (service) => {
      const read = spyOn(Request.prototype, "text");
      try {
        const response = await service.fetch("/posts", { method: "POST", headers: { "content-type": "application/json", "content-length": "2000000" }, body: "{}" });
        expect(response.status).toBe(413);
        expect(await errorOf(response)).toEqual({ code: "PAYLOAD_TOO_LARGE", message: "Request body is larger than 1MB" });
        expect(read).not.toHaveBeenCalled();
      } finally {
        read.mockRestore();
      }
    });
  });

  test("a streamed body stops after about the limit, and a smaller one passes", async () => {
    await withService({ "quickservicets.config.ts": CONFIG() }, async (service) => {
      const big = streamedJson(2 * 1024 * 1024);
      const refused = await service.fetch("/posts", big.init);
      expect(refused.status).toBe(413);
      expect((await errorOf(refused)).message).toBe("Request body is larger than 1MB");
      expect(big.state.pulled).toBeLessThanOrEqual(1024 * 1024 + 3 * 64 * 1024);
      const small = streamedJson(500 * 1024);
      expect((await service.fetch("/posts", small.init)).status).toBe(201);
    });
  });

  test("QS_SECURITY_LIMITS_BODY raises the limit", async () => {
    await withService(
      { "quickservicets.config.ts": CONFIG() },
      async (service) => {
        expect((await service.fetch("/posts", streamedJson(2 * 1024 * 1024).init)).status).toBe(201);
      },
      { QS_SECURITY_LIMITS_BODY: "5MB" },
    );
  });
});

describe("uploads and the server body size", () => {
  test("a multipart upload is limited by the file settings, not by the body limit", async () => {
    const files = {
      "quickservicets.config.ts": CONFIG(),
      "entities/Attachment.ts": 'import type { File } from "@quickservicets/core";\n/** @maxSize 10MB */\nexport type Attachment = File & { note?: string };\n',
    };
    await withService(files, async (service) => {
      const form = new FormData();
      form.append("file", new File([new Uint8Array(5 * 1024 * 1024)], "big.bin", { type: "application/octet-stream" }));
      const response = await service.fetch("/attachments", { method: "POST", body: form });
      expect(response.status).toBe(201);
    });
  });

  test("the server is started with the larger of the body limit and the largest upload plus form overhead", async () => {
    const models = parseProjectEntities(
      createProject({
        "entities/Photo.ts": 'import type { Media } from "@quickservicets/core";\nexport type Photo = Media & { caption?: string };\n',
        "entities/Album.ts": 'import type { Photo } from "./Photo";\nexport type Album = {\n  /** @maxTotalSize 50MB */\n  photos?: Photo[];\n};\n',
      }),
    );
    const sizeOf = async (config: Record<string, unknown>) => {
      const resolved = resolveConfig({ database: memoryAdapter(), logger: { info() {}, warn() {}, error() {} }, ...config } as ServiceConfig, {});
      const lifecycle = createFeatureLifecycle({ features: resolved.features, config: resolved, models, worker: { index: 0, count: 1, runsScheduledWork: true } });
      await lifecycle.setup();
      const serve = spyOn(Bun, "serve");
      try {
        const listening = createServer({ routes: [], repos: {}, config: { production: false }, ...lifecycle.server }).listen(0);
        await listening.stop(true);
        return (serve.mock.calls[0]![0] as { maxRequestBodySize?: number }).maxRequestBodySize;
      } finally {
        serve.mockRestore();
      }
    };
    expect(await sizeOf({})).toBe(50 * 1024 * 1024 + 64 * 1024);
    expect(await sizeOf({ security: { limits: false } })).toBeUndefined();
  });
});
