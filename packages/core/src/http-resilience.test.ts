import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { resetResilience, resilienceClock } from "./features/http/resilience.ts";
import { retryTiming } from "./features/http/retry.ts";
import { http, withBulkhead, withCircuitBreaker, type HttpClientError } from "./index.ts";
import { useTestResolver } from "./testing/index.ts";
import { resetHttpConfig, startHttpApp, upstream } from "./http-test-support.ts";

declare module "./features/http/client.ts" {
  interface HttpServiceNames {
    billing: true;
  }
}

const realClock = { ...resilienceClock };
const realTiming = { ...retryTiming };
afterEach(() => {
  Object.assign(resilienceClock, realClock);
  Object.assign(retryTiming, realTiming);
  resetResilience();
});
afterAll(() => resetHttpConfig());

const failure = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    return error as HttpClientError;
  }
  throw new Error("expected the call to fail");
};

/** A fake clock circuits read; `advance` moves it. */
const fakeClock = () => {
  const clock = { now: 1_000_000, advance: (ms: number) => void (clock.now += ms) };
  resilienceClock.now = () => clock.now;
  return clock;
};

/** A server answering with `status.current`. */
const switchable = (initial: number) => {
  const status = { current: initial };
  const server = upstream(() => Response.json({ status: status.current }, { status: status.current }));
  return { server, status };
};

describe("the circuit breaker", () => {
  test("five 5xx within the window open the circuit; the sixth call fails at once and the opening is logged once", async () => {
    const clock = fakeClock();
    const { server } = switchable(500);
    const restore = useTestResolver({ "billing.internal": "127.0.0.1" });
    const app = await startHttpApp({ http: { allow: ["loopback"], services: { billing: { url: `http://billing.internal:${server.port}`, circuitBreaker: true } } } });
    try {
      for (let index = 0; index < 5; index++) {
        expect((await failure(http.service("billing").get("/x").send())).status).toBe(500);
        clock.advance(1000);
      }
      const open = await failure(http.service("billing").get("/x").send());
      expect([open.code, open.status, open.message]).toEqual(["CIRCUIT_OPEN", 0, "Circuit open for billing"]);
      expect(server.seen).toHaveLength(5);
      expect(app.entries.filter((entry) => entry.message === "http.circuit.open")).toMatchObject([{ level: "warn", name: "billing", failures: 5 }]);
      expect(http.state("billing")).toEqual({ circuit: "open", failures: 5, inFlight: 0, waiting: 0 });
    } finally {
      await app.stop();
      restore();
      server.stop();
    }
  });

  test("4xx answers never count, and failures older than the window drop out", async () => {
    const clock = fakeClock();
    const { server, status } = switchable(404);
    resetHttpConfig();
    const breaker = withCircuitBreaker({ name: "counting" });
    try {
      for (let index = 0; index < 5; index++) await failure(http.get(server.url).use(breaker).send());
      expect(http.state("counting")).toMatchObject({ circuit: "closed", failures: 0 });
      status.current = 503;
      for (let index = 0; index < 4; index++) await failure(http.get(server.url).use(breaker).send());
      clock.advance(31_000);
      await failure(http.get(server.url).use(breaker).send());
      expect(http.state("counting")).toMatchObject({ circuit: "closed", failures: 1 });
      expect((await failure(http.get("http://127.0.0.1:1/").use(breaker).send())).code).toBe("NETWORK");
      expect(http.state("counting").failures).toBe(2);
    } finally {
      server.stop();
    }
  });

  test("after the cooldown one trial call goes through: a success closes the circuit, a failure opens it again", async () => {
    const clock = fakeClock();
    const { server, status } = switchable(500);
    const app = await startHttpApp({});
    const breaker = withCircuitBreaker({ name: "trial", failures: 2 });
    try {
      await failure(http.get(server.url).use(breaker).send());
      await failure(http.get(server.url).use(breaker).send());
      expect(http.state("trial").circuit).toBe("open");
      clock.advance(30_000);
      expect((await failure(http.get(server.url).use(breaker).send())).status).toBe(500);
      expect(server.seen).toHaveLength(3);
      expect(http.state("trial").circuit).toBe("open");
      clock.advance(30_000);
      status.current = 200;
      // While the trial runs, other calls are rejected as open.
      const trial = http.get(server.url).use(breaker).send();
      expect((await failure(http.get(server.url).use(breaker).send())).code).toBe("CIRCUIT_OPEN");
      expect(await trial).toEqual({ status: 200 });
      expect(http.state("trial").circuit).toBe("closed");
      const messages = app.entries.map((entry) => entry.message).filter((message) => String(message).startsWith("http.circuit."));
      expect(messages).toEqual(["http.circuit.open", "http.circuit.half-open", "http.circuit.open", "http.circuit.half-open", "http.circuit.closed"]);
      expect(app.entries.find((entry) => entry.message === "http.circuit.closed")!.level).toBe("info");
    } finally {
      await app.stop();
      server.stop();
    }
  });
});

describe("the bulkhead", () => {
  test("two run, one waits and the fourth is refused; a wait past queueTimeout is refused too", async () => {
    resetHttpConfig();
    const server = upstream(async () => {
      await Bun.sleep(300);
      return Response.json({ ok: true });
    });
    const bulkhead = withBulkhead({ name: "slow", concurrency: 2, queue: 1 });
    try {
      const calls = Array.from({ length: 4 }, () => http.get(server.url).use(bulkhead).send().then(() => "ok", (error: HttpClientError) => error.code));
      await Bun.sleep(50);
      expect(http.state("slow")).toEqual({ circuit: undefined, failures: 0, inFlight: 2, waiting: 1 });
      expect(await Promise.all(calls)).toEqual(["ok", "ok", "ok", "BULKHEAD_FULL"]);
      expect(http.state("slow")).toMatchObject({ inFlight: 0, waiting: 0 });
      const short = withBulkhead({ name: "short", concurrency: 1, queue: 5, queueTimeout: "100ms" });
      const first = http.get(server.url).use(short).send();
      const waited = await failure(http.get(server.url).use(short).send());
      expect([waited.code, waited.message]).toEqual(["BULKHEAD_FULL", "Bulkhead full for short"]);
      await first;
    } finally {
      server.stop();
    }
  });
});

describe("services and the 503 answer", () => {
  test("an escaping CIRCUIT_OPEN answers 503 with the remaining cooldown, and retries never repeat an open circuit", async () => {
    const clock = fakeClock();
    Object.assign(retryTiming, { sleep: async () => undefined, random: () => 0 });
    const { server } = switchable(503);
    const restore = useTestResolver({ "billing.internal": "127.0.0.1" });
    const app = await startHttpApp(
      { http: { allow: ["loopback"], services: { billing: { url: `http://billing.internal:${server.port}`, retry: true, circuitBreaker: { failures: 2, cooldown: "30s" } } } } },
      { "GET /invoices": () => http.service("billing").get("/invoices").send() },
    );
    try {
      // The retry is outside the breaker: the first call's two failing attempts open it, and its third attempt is not
      // retried once it is open.
      expect((await app.fetch("/invoices")).status).toBe(503);
      expect(server.seen).toHaveLength(2);
      clock.advance(10_000);
      const response = await app.fetch("/invoices");
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect([response.status, body.error.code, body.error.message, response.headers.get("retry-after")]).toEqual([503, "SERVICE_UNAVAILABLE", "Upstream unavailable", "20"]);
      expect(server.seen).toHaveLength(2);
      expect(app.entries.filter((entry) => entry.message === "http.call" && entry.status === 503)).toHaveLength(2);
    } finally {
      await app.stop();
      restore();
      server.stop();
    }
  });
});
