import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import { memoryAdapter } from "./adapters/memory.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { readMultipart } from "./files/upload.ts";
import { createServer, type Route, type ServerSettings } from "./http/server.ts";
import { createFeatureLifecycle } from "./lifecycle.ts";
// Loading the core registers the natives it ships.
import "./index.ts";

const quiet = { info() {}, warn() {}, error() {} };
const resolve = (config: Record<string, unknown> = {}, env: Record<string, string> = {}) => resolveConfig({ database: memoryAdapter(), logger: quiet, ...config } as ServiceConfig, env);

/** The middlewares and server settings the security native gives for a configuration. */
async function setUp(config: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const resolved = resolve(config, env);
  const lifecycle = createFeatureLifecycle({ features: resolved.features, config: resolved, models: [], worker: { index: 0, count: 1, runsScheduledWork: true } });
  await lifecycle.setup();
  return lifecycle;
}

const routes: Route[] = [
  { method: "POST", path: "/json", handler: async (_repos, req) => ({ received: JSON.stringify(await req.json()).length }) },
  { method: "POST", path: "/upload", handler: async (_repos, req) => ({ parts: [...(await readMultipart(req)).keys()] }) },
];

async function serve(config: Record<string, unknown> = {}) {
  const lifecycle = await setUp(config);
  return createServer({ routes, repos: {}, config: { production: false, logger: quiet }, middleware: { request: lifecycle.middleware.map((entry) => entry.middleware).filter((entry) => entry.stage === "request") as never, handler: [], error: [] }, ...lifecycle.server });
}

/** A body sent in two parts: the first at once, the second when `release()` is called. */
function twoParts(first: string, second: string) {
  const encoder = new TextEncoder();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let step = 0;
  const started = { value: false };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      step++;
      if (step === 1) {
        started.value = true;
        controller.enqueue(encoder.encode(first));
      } else if (step === 2) {
        await gate;
        controller.enqueue(encoder.encode(second));
      } else controller.close();
    },
  });
  return { body, release, started };
}

/** Lets pending promise callbacks run without letting fake time pass. */
async function settle(until: () => boolean) {
  for (let turn = 0; turn < 1000 && !until(); turn++) await Promise.resolve();
}

afterEach(() => {
  jest.useRealTimers();
});

describe("idle timeout", () => {
  const idleOf = async (config: Record<string, unknown>, env: Record<string, string> = {}) => {
    const lifecycle = await setUp(config, env);
    const serveSpy = spyOn(Bun, "serve");
    try {
      const listening = createServer({ routes: [], repos: {}, config: { production: false }, ...lifecycle.server }).listen(0);
      await listening.stop(true);
      return (serveSpy.mock.calls[0]![0] as { idleTimeout?: number }).idleTimeout;
    } finally {
      serveSpy.mockRestore();
    }
  };

  test("30 seconds by default, the configured or environment value in seconds, none with the item off", async () => {
    expect(await idleOf({})).toBe(30);
    expect(await idleOf({}, { QS_SECURITY_TIMEOUTS_IDLE: "1m" })).toBe(60);
    expect(await idleOf({ security: { timeouts: { idle: "4m" } } })).toBe(240);
    expect(await idleOf({ security: { timeouts: { idle: "0s" } } })).toBe(0);
    expect(await idleOf({ security: { timeouts: false } })).toBeUndefined();
  });

  test("more than the Bun limit fails the configuration", () => {
    expect(() => resolve({ security: { timeouts: { idle: "300s" } } })).toThrow("Invalid security.timeouts.idle: expected at most 255s (the Bun limit), got 300s");
  });
});

describe("read deadlines", () => {
  test("a JSON body whose second part comes 31 seconds later answers 408 and closes the connection", async () => {
    const server = await serve();
    jest.useFakeTimers();
    const { body, release, started } = twoParts('{"title":', '"late"}');
    const pending = server.fetch(new Request("http://localhost/json", { method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half" } as RequestInit));
    await settle(() => started.value);
    jest.advanceTimersByTime(31_000);
    release();
    const response = await pending;
    expect(response.status).toBe(408);
    expect(response.headers.get("connection")).toBe("close");
    expect(await response.json()).toEqual({ error: { code: "REQUEST_TIMEOUT", message: "Request body was not received in time" } });
  });

  test("a JSON body within the deadline is read", async () => {
    const server = await serve();
    jest.useFakeTimers();
    const { body, release, started } = twoParts('{"title":', '"soon"}');
    const pending = server.fetch(new Request("http://localhost/json", { method: "POST", body, duplex: "half" } as RequestInit));
    await settle(() => started.value);
    jest.advanceTimersByTime(29_000);
    release();
    expect((await pending).status).toBe(200);
  });

  test("an upload has ten minutes: two minutes pass, eleven answer 408", async () => {
    const boundary = "xyz";
    const form = (minutes: number) => ({
      first: `--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\n`,
      second: `${minutes} minutes\r\n--${boundary}--\r\n`,
    });
    for (const [minutes, status] of [[2, 200], [11, 408]] as const) {
      const server = await serve();
      jest.useFakeTimers();
      const parts = form(minutes);
      const { body, release, started } = twoParts(parts.first, parts.second);
      const pending = server.fetch(new Request("http://localhost/upload", { method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, body, duplex: "half" } as RequestInit));
      await settle(() => started.value);
      jest.advanceTimersByTime(minutes * 60_000);
      release();
      expect((await pending).status).toBe(status);
      jest.useRealTimers();
    }
  });
});

describe("timer cleanup", () => {
  test("after 1000 fast requests no read timer is pending", async () => {
    const server = await serve();
    const pending = new Set<unknown>();
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const setSpy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      const handle = realSet(() => {
        pending.delete(handle);
        fn();
      }, ms);
      if (ms === 30_000) pending.add(handle);
      return handle;
    }) as typeof setTimeout);
    const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation(((handle: ReturnType<typeof setTimeout>) => {
      pending.delete(handle);
      realClear(handle);
    }) as typeof clearTimeout);
    try {
      let created = 0;
      for (let index = 0; index < 1000; index++) {
        const response = await server.fetch(new Request("http://localhost/json", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ index }) }));
        expect(response.status).toBe(200);
      }
      created = setSpy.mock.calls.filter((call) => call[1] === 30_000).length;
      expect(created).toBe(1000);
      expect(pending.size).toBe(0);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});
