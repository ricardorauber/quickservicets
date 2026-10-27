import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { memoryAdapter } from "./adapters/memory.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { CODES_BY_STATUS } from "./errors.ts";
import { http, HttpClientError } from "./index.ts";
import { closedPort, resetHttpConfig, startHttpApp, upstream } from "./http-test-support.ts";

afterAll(resetHttpConfig);

const failure = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    return error as HttpClientError;
  }
  throw new Error("expected the call to fail");
};

describe("the builder", () => {
  test("sends the JSON body, headers and query, and resolves the parsed body", async () => {
    resetHttpConfig();
    const server = upstream(async (request) => Response.json({ ok: true, echo: await request.json() }));
    try {
      const result = await http.post(server.url + "/orders").json({ a: 1 }).header("x-k", "v").query({ page: 2, tags: ["a", "b"], skip: undefined }).send<{ ok: boolean; echo: unknown }>();
      expect(result).toEqual({ ok: true, echo: { a: 1 } });
      const seen = server.seen[0]!;
      expect(new URL(seen.url).search).toBe("?page=2&tags=a&tags=b");
      expect(seen.headers.get("x-k")).toBe("v");
      expect(seen.headers.get("content-type")).toBe("application/json");
      expect(seen.headers.get("user-agent")).toMatch(/^quickservicets\//);
    } finally {
      server.stop();
    }
  });

  test("every method returns a new builder, so a base builder is reused safely", async () => {
    resetHttpConfig();
    const server = upstream(() => new Response("ok"));
    try {
      const base = http.get(server.url).bearer("t");
      await base.header("x-one", "1").send();
      await base.header("x-two", "2").headers({ "x-three": "3" }).send();
      const [first, second] = server.seen;
      expect([first!.headers.get("x-one"), first!.headers.get("x-two"), first!.headers.get("authorization")]).toEqual(["1", null, "Bearer t"]);
      expect([second!.headers.get("x-one"), second!.headers.get("x-two"), second!.headers.get("x-three")]).toEqual([null, "2", "3"]);
    } finally {
      server.stop();
    }
  });

  test("form bodies are URL-encoded or multipart, raw bodies are sent as given", async () => {
    resetHttpConfig();
    const server = upstream(async (request) => new Response(`${request.headers.get("content-type")?.split(";")[0]}|${await request.text()}`));
    try {
      expect(await http.post(server.url).form({ a: "1", b: [2, 3] }).text()).toBe("application/x-www-form-urlencoded|a=1&b=2&b=3");
      const data = new FormData();
      data.set("name", "x");
      expect(await http.post(server.url).form(data).text()).toStartWith("multipart/form-data|");
      expect(await http.put(server.url).body("raw text").text()).toEndWith("|raw text");
      expect(await http.patch(server.url).body(new Uint8Array([104, 105])).text()).toEndWith("|hi");
      expect(await http.delete(server.url).body(new Blob(["blob"])).text()).toEndWith("|blob");
      expect(() => http.get("/relative")).toThrow("http.get() takes an absolute http or https URL");
    } finally {
      server.stop();
    }
  });
});

describe("terminals", () => {
  test("send() parses JSON and +json, returns text otherwise and undefined for an empty body; text() and bytes() read the body", async () => {
    resetHttpConfig();
    const server = upstream((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/json") return Response.json({ n: 1 });
      if (path === "/problem") return new Response('{"p":1}', { headers: { "content-type": "application/problem+json" } });
      if (path === "/empty") return new Response(null, { status: 204 });
      return new Response("plain");
    });
    try {
      expect(await http.get(`${server.url}/json`).send()).toEqual({ n: 1 });
      expect(await http.get(`${server.url}/problem`).send()).toEqual({ p: 1 });
      expect(await http.get(`${server.url}/empty`).send()).toBeUndefined();
      expect(await http.get(`${server.url}/text`).send()).toBe("plain");
      expect(await http.head(`${server.url}/json`).send()).toBeUndefined();
      expect(await http.get(`${server.url}/json`).text()).toBe('{"n":1}');
      expect(new TextDecoder().decode(await http.get(`${server.url}/text`).bytes())).toBe("plain");
      const response = await http.get(`${server.url}/json`).response();
      expect([response.status, response.ok, response.headers.get("content-type"), await response.json()]).toEqual([200, true, "application/json;charset=utf-8", { n: 1 }]);
    } finally {
      server.stop();
    }
  });
});

describe("errors", () => {
  test("a status outside 2xx rejects send() with HTTP_STATUS and the parsed body, while response() resolves it", async () => {
    resetHttpConfig();
    const server = upstream(() => Response.json({ error: "missing" }, { status: 404 }));
    try {
      const error = await failure(http.get(`${server.url}/items/1?token=abcdef&page=2`).send());
      expect(error).toBeInstanceOf(HttpClientError);
      expect([error.code, error.status, error.method, error.body]).toEqual(["HTTP_STATUS", 404, "GET", { error: "missing" }]);
      expect(error.url).toBe(`${server.url}/items/1?token=[secret]&page=2`);
      expect(error.message).toBe(`GET ${server.url}/items/1?token=[secret]&page=2 responded 404`);
      expect((await failure(http.get(server.url).text())).code).toBe("HTTP_STATUS");
      const response = await http.get(server.url).response();
      expect([response.status, response.ok]).toEqual([404, false]);
    } finally {
      server.stop();
    }
  });

  test("timeouts cover the body, aborts, sizes, closed ports and invalid JSON each have their code", async () => {
    resetHttpConfig();
    const server = upstream(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/slow") {
        await Bun.sleep(2000);
        return new Response("late");
      }
      if (path === "/slow-body") {
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode("first"));
              await Bun.sleep(2000);
              controller.close();
            },
          }),
        );
      }
      if (path === "/big") return new Response(new Uint8Array(20 * 1024 * 1024));
      if (path === "/big-stream") {
        const chunk = new Uint8Array(1024 * 1024);
        let sent = 0;
        return new Response(new ReadableStream({ pull: (controller) => (sent++ < 20 ? controller.enqueue(chunk) : controller.close()) }));
      }
      return new Response("{nope", { headers: { "content-type": "application/json" } });
    });
    try {
      const started = performance.now();
      const timeout = await failure(http.get(`${server.url}/slow`).timeout("500ms").send());
      const elapsed = performance.now() - started;
      expect([timeout.code, timeout.status, timeout.message]).toEqual(["TIMEOUT", 0, `GET ${server.url}/slow timed out after 500ms`]);
      expect(elapsed).toBeGreaterThanOrEqual(450);
      expect(elapsed).toBeLessThan(1500);
      expect((await failure(http.get(`${server.url}/slow-body`).timeout(300).text())).code).toBe("TIMEOUT");

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100);
      expect((await failure(http.get(`${server.url}/slow`).signal(controller.signal).send())).code).toBe("ABORTED");

      const big = await failure(http.get(`${server.url}/big`).send());
      expect([big.code, big.message]).toEqual(["RESPONSE_TOO_LARGE", `Response from ${server.url}/big is larger than 10MB`]);
      expect((await failure(http.get(`${server.url}/big-stream`).send())).code).toBe("RESPONSE_TOO_LARGE");

      const port = closedPort();
      const network = await failure(http.get(`http://127.0.0.1:${port}/x`).send());
      expect([network.code, network.status]).toEqual(["NETWORK", 0]);
      expect(network.message).toStartWith(`GET http://127.0.0.1:${port}/x failed: `);

      expect((await failure(http.get(`${server.url}/invalid`).send())).code).toBe("INVALID_RESPONSE");
    } finally {
      server.stop();
    }
  }, 15_000);
});

describe("the error middleware", () => {
  test("an escaping TIMEOUT answers 504 and other client errors 502, with details only outside production, and both are logged", async () => {
    expect([CODES_BY_STATUS[502], CODES_BY_STATUS[504]]).toEqual(["BAD_GATEWAY", "GATEWAY_TIMEOUT"]);
    const server = upstream(async (request) => {
      if (new URL(request.url).pathname === "/slow") await Bun.sleep(1000);
      return new Response("down", { status: 500 });
    });
    for (const production of [false, true]) {
      const app = await startHttpApp({ production }, {
        "GET /timeout": () => http.get(`${server.url}/slow`).timeout(100).send(),
        "GET /failed": () => http.get(`${server.url}/fail`).send(),
      });
      try {
        const timeout = await app.fetch("/timeout");
        const timeoutBody = (await timeout.json()) as { error: { code: string; message: string; details?: { status: number; url: string } } };
        expect([timeout.status, timeoutBody.error.code, timeoutBody.error.message]).toEqual([504, "GATEWAY_TIMEOUT", "Upstream request timed out"]);
        const failed = await app.fetch("/failed");
        const failedBody = (await failed.json()) as typeof timeoutBody;
        expect([failed.status, failedBody.error.code, failedBody.error.message]).toEqual([502, "BAD_GATEWAY", "Upstream request failed"]);
        if (production) expect(failedBody.error.details).toBeUndefined();
        else expect(failedBody.error.details).toMatchObject({ status: 500, url: `${server.url}/fail` });
        const logged = app.entries.filter((entry) => entry.level === "error" && (entry.error as { name?: string } | undefined)?.name === "HttpClientError");
        expect(logged).toHaveLength(2);
      } finally {
        await app.stop();
      }
    }
    server.stop();
  });
});

describe("enabling", () => {
  test("http: false makes every call throw, and a script without a configuration uses the defaults", async () => {
    resolveConfig({ database: memoryAdapter(), http: false } as ServiceConfig, {});
    expect(() => http.get("http://example.test/")).toThrow("http is disabled (http: false in quickservicets.config.ts)");
    resetHttpConfig();
    expect(() => http.get("http://example.test/")).not.toThrow();
    const script = `import { http } from "${join(import.meta.dir, "index.ts")}"; import { currentSettings, describeCall } from "${join(import.meta.dir, "features/http/client.ts")}"; const settings = currentSettings(); console.log(JSON.stringify([settings.options.timeout, (await describeCall({ method: "GET", url: new URL("http://x.test"), headers: [], query: [], modifiers: [] }, settings, {})).timeout, typeof http.get]));`;
    const child = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
    const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(JSON.parse(stdout)).toEqual(["10s", 10_000, "function"]);
  });
});
