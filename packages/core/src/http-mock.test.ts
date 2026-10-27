import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { retryTiming } from "./features/http/retry.ts";
import { http, HttpClientError, withRetry } from "./index.ts";
import { mockHttp, type HttpMock } from "./testing/index.ts";
import { resetHttpConfig, startHttpApp, upstream } from "./http-test-support.ts";

declare module "./features/http/client.ts" {
  interface HttpServiceNames {
    billing: true;
  }
}

let active: HttpMock | undefined;
const realTiming = { ...retryTiming };
afterEach(() => {
  active?.restore();
  active = undefined;
  Object.assign(retryTiming, realTiming);
});
afterAll(() => resetHttpConfig());

const start = () => (active = http.mock());

const failure = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    return error as HttpClientError;
  }
  throw new Error("expected the call to fail");
};

describe("matching", () => {
  test("by method, exact URL, prefix, RegExp, query and service path; the latest handler wins", async () => {
    resetHttpConfig({ services: { billing: { url: "http://billing.internal/v1" } } });
    const mock = start();
    mock.on("GET", "https://api.test/users/*").reply(200, { kind: "prefix" });
    mock.on("GET", "https://api.test/users/7").reply(200, { kind: "exact" });
    mock.on("*", /\/orders\/\d+$/).reply(200, { kind: "regexp" });
    mock.on("GET", "https://api.test/search?q=a").reply(200, { kind: "query" });
    mock.service("billing").on("POST", "/invoices").reply(201, { kind: "service" });
    expect(await http.get("https://api.test/users/1?expand=x").send()).toEqual({ kind: "prefix" });
    expect(await http.get("https://api.test/users/7?expand=x").send()).toEqual({ kind: "exact" });
    expect(await http.delete("https://api.test/orders/12").send()).toEqual({ kind: "regexp" });
    expect(await http.get("https://api.test/search?q=a").send()).toEqual({ kind: "query" });
    expect((await failure(http.get("https://api.test/search?q=a&page=2").send())).code).toBe("UNMATCHED_MOCK");
    expect((await failure(http.post("https://api.test/users/7").send())).code).toBe("UNMATCHED_MOCK");
    expect(await http.service("billing").post("/invoices").send()).toEqual({ kind: "service" });
    expect((await failure(http.post("http://billing.internal/v1/invoices").send())).code).toBe("UNMATCHED_MOCK");
  });
});

describe("answers", () => {
  test("reply, replyWith, fail, delay and once", async () => {
    resetHttpConfig({ services: { billing: { url: "http://billing.internal/v1" } } });
    const mock = start();
    mock.on("GET", "https://api.test/text").reply(200, "plain", { "x-from": "mock" });
    mock.service("billing").on("POST", "/invoices").replyWith(({ body }) => ({ status: 201, body: JSON.parse(body) }));
    mock.on("GET", "https://api.test/raw").replyWith(async ({ headers }) => new Response(headers.get("x-ask")));
    mock.on("GET", "https://api.test/later").reply(200, { later: true });
    mock.on("GET", "https://api.test/later").reply(200, { first: true }).once();
    mock.on("GET", "https://api.test/unused").reply(200).once();
    mock.on("GET", "https://api.test/down").fail("network");
    mock.on("GET", "https://api.test/custom").fail(new HttpClientError({ code: "CUSTOM", message: "custom failure", method: "GET", url: "https://api.test/custom" }));
    const response = await http.get("https://api.test/text").response();
    expect([await response.text(), response.headers.get("x-from")]).toEqual(["plain", "mock"]);
    expect(await http.service("billing").post("/invoices").json({ total: 5 }).send()).toEqual({ total: 5 });
    expect(await http.get("https://api.test/raw").header("x-ask", "echo").text()).toBe("echo");
    expect(await http.get("https://api.test/later").send()).toEqual({ first: true });
    expect(await http.get("https://api.test/later").send()).toEqual({ later: true });
    expect(mock.pending()).toEqual([{ method: "GET", pattern: "https://api.test/unused" }]);
    expect((await failure(http.get("https://api.test/down").send())).code).toBe("NETWORK");
    expect((await failure(http.get("https://api.test/custom").send())).message).toBe("custom failure");
  });
});

describe("modifiers, timeouts and logging", () => {
  test("a failure once then a reply resolves on the retry; a delay past the timeout times out; calls are logged", async () => {
    Object.assign(retryTiming, { sleep: async () => undefined });
    const app = await startHttpApp({});
    try {
      const mock = start();
      mock.on("GET", "https://api.test/flaky").reply(200, { ok: true });
      mock.on("GET", "https://api.test/flaky").fail("network").once();
      expect(await http.get("https://api.test/flaky").use(withRetry()).send()).toEqual({ ok: true });
      expect(mock.calls.map((call) => call.attempt)).toEqual([1, 2]);
      mock.on("GET", "https://api.test/slow").reply(200).delay("2s");
      const started = performance.now();
      expect((await failure(http.get("https://api.test/slow").timeout("1s").send())).code).toBe("TIMEOUT");
      expect(performance.now() - started).toBeLessThan(1800);
      mock.on("GET", "https://api.test/timeout").fail("timeout");
      expect((await failure(http.get("https://api.test/timeout").send())).code).toBe("TIMEOUT");
      mock.on("GET", "https://api.test/big").reply(200, "x".repeat(2048));
      resetHttpConfig({ maxResponseSize: "1KB" });
      expect((await failure(http.get("https://api.test/big").send())).code).toBe("RESPONSE_TOO_LARGE");
      expect(app.entries.filter((entry) => entry.message === "http.call").map((entry) => [entry.attempt, entry.status, entry.error ?? null])).toEqual([
        [1, 0, "NETWORK"],
        [2, 200, null],
        [1, 0, "TIMEOUT"],
        [1, 0, "TIMEOUT"],
      ]);
    } finally {
      await app.stop();
    }
  }, 10_000);
});

describe("unmatched calls and records", () => {
  test("a local address answers under the mock; an unmatched call lists the patterns; calls keep the request", async () => {
    resetHttpConfig({});
    const mock = start();
    mock.on("POST", "http://127.0.0.1/x").reply(200, { local: true });
    expect(await http.post("http://127.0.0.1/x").header("x-k", "v").json({ a: 1 }).send()).toEqual({ local: true });
    const unmatched = await failure(http.get("https://nowhere.test/y?token=secret-1").send());
    expect([unmatched.code, unmatched.message, unmatched.details]).toEqual(["UNMATCHED_MOCK", "Unmatched request GET https://nowhere.test/y?token=[secret]", { patterns: [{ method: "POST", pattern: "http://127.0.0.1/x" }] }]);
    expect(mock.calls[0]).toMatchObject({ method: "POST", url: "http://127.0.0.1/x", body: '{"a":1}', attempt: 1, headers: { "x-k": "v", "content-type": "application/json" } });
    expect(mock.calls).toHaveLength(2);
  });

  test("req.http calls carry the request id into the mock", async () => {
    const app = await startHttpApp({}, { "GET /user": (req) => req.http.get("https://api.test/users/1").send() });
    try {
      const mock = start();
      mock.on("GET", "https://api.test/users/*").reply(200, { id: 1 });
      const response = await app.fetch("/user");
      expect(await response.json()).toEqual({ id: 1 });
      expect(mock.calls[0]!.headers["x-request-id"]).toBe(response.headers.get("x-request-id")!);
    } finally {
      await app.stop();
    }
  });
});

describe("activation", () => {
  test("a second mock while one is active throws; after restore the network answers again; mockHttp is http.mock", async () => {
    resetHttpConfig();
    const server = upstream(() => Response.json({ real: true }));
    try {
      const mock = start();
      expect(() => http.mock()).toThrow("http.mock() is already active; call restore() first");
      mock.on("GET", `${server.url}/`).reply(200, { mocked: true });
      expect(await http.get(`${server.url}/`).send()).toEqual({ mocked: true });
      mock.restore();
      active = undefined;
      expect(await http.get(`${server.url}/`).send()).toEqual({ real: true });
      const again = (active = mockHttp());
      again.on("GET", `${server.url}/`).reply(200, { again: true });
      expect(await http.get(`${server.url}/`).send()).toEqual({ again: true });
    } finally {
      server.stop();
    }
  });
});
