import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { defineFeature } from "./features.ts";
import { backoffMs, retryAfterMs, retryTiming } from "./features/http/retry.ts";
import { defineModifier, http, withRetry, type HttpClientError } from "./index.ts";
import { useTestResolver } from "./testing/index.ts";
import { resetHttpConfig, startHttpApp, upstream } from "./http-test-support.ts";

declare module "./features/http/client.ts" {
  interface HttpServiceNames {
    billing: true;
  }
}

const realTiming = { ...retryTiming };
afterEach(() => Object.assign(retryTiming, realTiming));
afterAll(() => resetHttpConfig());

const failure = async (work: Promise<unknown> | (() => Promise<unknown>)) => {
  try {
    await (typeof work === "function" ? work() : work);
  } catch (error) {
    return error as HttpClientError;
  }
  throw new Error("expected the call to fail");
};

/** Fake timers: records every wait and resolves it at once; jitter draws `random`. */
const fakeTiming = (random = 0.5) => {
  const waits: number[] = [];
  Object.assign(retryTiming, { sleep: async (ms: number) => void waits.push(ms), random: () => random });
  return waits;
};

/** A server answering each request with the next status of `statuses` (the last one repeating). */
const sequence = (statuses: number[], headers: Record<string, string> = {}) => {
  let index = 0;
  return upstream(() => {
    const status = statuses[Math.min(index++, statuses.length - 1)]!;
    return Response.json({ status }, { status, headers });
  });
};

describe("the modifier contract", () => {
  test("modifiers run in .use() order around the call, see the response, and may replace it", async () => {
    resetHttpConfig();
    const server = upstream((request) => Response.json({ header: request.headers.get("x-added") }));
    try {
      const order: string[] = [];
      const add = defineModifier(async (request, next) => {
        order.push("add:before");
        request.headers.set("x-added", "yes");
        const response = await next();
        order.push(`add:after:${response.status}`);
        return response;
      });
      const time = defineModifier(async (request, next) => {
        order.push(`time:before:${request.headers.get("x-added")}`);
        const response = await next(request);
        order.push(`time:after:${response.status}`);
        return response;
      });
      expect(await http.get(server.url).use(add).use(time).send()).toEqual({ header: "yes" });
      expect(order).toEqual(["add:before", "time:before:yes", "time:after:200", "add:after:200"]);
      const replace = defineModifier(() => Response.json({ replaced: true }));
      expect(await http.get(server.url).use(replace).send()).toEqual({ replaced: true });
      expect(server.seen).toHaveLength(1);
    } finally {
      server.stop();
    }
  });

  test("a modifier throwing anything but an HttpClientError fails the call with MODIFIER_FAILED", async () => {
    resetHttpConfig();
    const bad = defineModifier(() => {
      throw new Error("bad");
    }, "signature");
    const error = await failure(http.get("http://127.0.0.1:1/").use(bad).send());
    expect([error.code, error.message, (error.cause as Error).message]).toEqual(["MODIFIER_FAILED", "Modifier signature failed: bad", "bad"]);
  });
});

describe("retry conditions", () => {
  test("503, 503, then 200 resolves on the third attempt with an http.call entry per attempt and delays within the backoff", async () => {
    const waits = fakeTiming(0.99);
    const server = sequence([503, 503, 200]);
    const app = await startHttpApp({});
    try {
      expect(await http.get(server.url).use(withRetry()).send()).toEqual({ status: 200 });
      const calls = app.entries.filter((entry) => entry.message === "http.call");
      expect(calls.map((entry) => [entry.attempt, entry.status])).toEqual([
        [1, 503],
        [2, 503],
        [3, 200],
      ]);
      expect(waits).toHaveLength(2);
      expect(waits[0]!).toBeLessThan(200);
      expect(waits[1]!).toBeGreaterThanOrEqual(200);
      expect(waits[1]!).toBeLessThan(400);
    } finally {
      await app.stop();
      server.stop();
    }
  });

  test("a POST is retried only with an Idempotency-Key or when methods list it; 4xx other than 408 and 429 are not retried", async () => {
    fakeTiming();
    resetHttpConfig();
    const server = sequence([503, 200]);
    try {
      expect((await failure(http.post(server.url).json({}).use(withRetry()).send())).status).toBe(503);
      expect(server.seen).toHaveLength(1);
      expect(await http.post(server.url).json({}).header("idempotency-key", "k1").use(withRetry()).send()).toEqual({ status: 200 });
      expect(await http.post(server.url).use(withRetry({ methods: ["POST"] })).send()).toEqual({ status: 200 });
    } finally {
      server.stop();
    }
    const notFound = sequence([404, 200]);
    try {
      expect((await failure(http.get(notFound.url).use(withRetry()).send())).status).toBe(404);
      expect(notFound.seen).toHaveLength(1);
    } finally {
      notFound.stop();
    }
  });

  test("SSRF blocks, stream bodies and network failures follow their rules", async () => {
    fakeTiming();
    resetHttpConfig({});
    let attempts = 0;
    const counting = defineModifier(async (_request, next) => (attempts++, next()));
    expect((await failure(http.get("http://10.0.0.1/").use(withRetry()).use(counting).send())).code).toBe("SSRF_BLOCKED");
    expect(attempts).toBe(1);
    resetHttpConfig();
    attempts = 0;
    expect((await failure(http.get("http://127.0.0.1:1/").use(withRetry()).use(counting).send())).code).toBe("NETWORK");
    expect(attempts).toBe(3);
    const server = sequence([503, 200]);
    try {
      const stream = new ReadableStream({ start: (controller) => (controller.enqueue(new TextEncoder().encode("x")), controller.close()) });
      expect((await failure(http.put(server.url).body(stream).use(withRetry()).send())).status).toBe(503);
    } finally {
      server.stop();
    }
  });
});

describe("backoff and Retry-After", () => {
  test("the backoff doubles with full jitter up to the cap; Retry-After is waited, and one longer than maxRetryAfter is not retried", async () => {
    expect([backoffMs(2, 200, 5000, () => 0.999), backoffMs(3, 200, 5000, () => 0.999), backoffMs(8, 200, 5000, () => 0.999), backoffMs(2, 200, 5000, () => 0)]).toEqual([199, 399, 4995, 0]);
    expect(retryAfterMs("2")).toBe(2000);
    expect(retryAfterMs(new Date(Date.now() + 10_000).toUTCString())).toBeGreaterThan(8000);
    expect(retryAfterMs("soon")).toBeUndefined();
    const waits = fakeTiming();
    resetHttpConfig();
    const short = sequence([503, 200], { "retry-after": "2" });
    const long = sequence([503, 200], { "retry-after": "120" });
    try {
      expect(await http.get(short.url).use(withRetry()).send()).toEqual({ status: 200 });
      expect(waits).toEqual([2000]);
      expect((await failure(http.get(long.url).use(withRetry()).send())).status).toBe(503);
      expect(long.seen).toHaveLength(1);
    } finally {
      short.stop();
      long.stop();
    }
  });

  test("each attempt gets the call's full timeout", async () => {
    fakeTiming();
    let index = 0;
    const server = upstream(async () => {
      if (index++ === 0) await Bun.sleep(400);
      return Response.json({ ok: true });
    });
    resetHttpConfig();
    try {
      expect(await http.get(server.url).timeout(250).use(withRetry()).send()).toEqual({ ok: true });
    } finally {
      server.stop();
    }
  });
});

describe("services and named modifiers", () => {
  const signing = (key: string, seen: string[]) =>
    defineFeature({
      key,
      after: ["http"],
      setup: (ctx) =>
        ctx.feature("http").modifier(
          "signature",
          defineModifier(async (request, next) => {
            seen.push(`signature:${request.attempt}`);
            request.headers.set("x-signature", `signed-${request.attempt}`);
            return next();
          }),
        ),
    });

  test("retry: true and a feature's modifier run through the service, the modifier inside the retry", async () => {
    fakeTiming();
    const server = sequence([503, 200]);
    const restore = useTestResolver({ "billing.internal": "127.0.0.1" });
    const seen: string[] = [];
    const app = await startHttpApp({ http: { services: { billing: { url: `http://billing.internal:${server.port}`, retry: true, modifiers: ["signature"] } } } }, {}, [signing("signer", seen)]);
    try {
      expect(await http.service("billing").get("/x").send()).toEqual({ status: 200 });
      expect(seen).toEqual(["signature:1", "signature:2"]);
      expect(server.seen.map((request) => request.headers.get("x-signature"))).toEqual(["signed-1", "signed-2"]);
    } finally {
      await app.stop();
      restore();
      server.stop();
    }
  });

  test("an unknown modifier and one registered twice fail startup", async () => {
    const unknown = await failure(() => startHttpApp({ http: { services: { billing: { url: "http://billing.internal", modifiers: ["nope"] } } } }));
    expect(unknown.message).toContain("Unknown modifier nope in http.services.billing.modifiers (registered: retry, circuitBreaker, bulkhead, cache)");
    const twice = await failure(() => startHttpApp({}, {}, [signing("first", []), signing("second", [])]));
    expect(twice.message).toContain("HTTP modifier signature is registered by first and second");
  });
});
