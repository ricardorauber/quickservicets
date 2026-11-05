import { afterEach, describe, expect, test } from "bun:test";
import "./index.ts";
import { defineFeature, registerProjectFeatures } from "./features.ts";
import { resolveConfig } from "./config.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { startTestApp, type TestApp } from "./tenancy-test-support.ts";
import { discoveryCandidates as candidates, discoverSettings, http, pickInstance, setDiscoveryRandom, type RegistryProvider, type ServiceInstance, type ServiceRequest } from "./index.ts";

const started: TestApp[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const app of started.splice(0)) await app.stop();
  for (const server of servers.splice(0)) server.stop(true);
  registerProjectFeatures([]);
  setDiscoveryRandom();
});

/** An upstream that answers its name, or the status `status()` gives, after `delay()` milliseconds. */
function upstream(name: string, options: { status?: () => number; delay?: () => number } = {}) {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      hits.push(new URL(request.url).pathname);
      const wait = options.delay?.() ?? 0;
      if (wait > 0) await Bun.sleep(wait);
      return Response.json({ from: name }, { status: options.status?.() ?? 200 });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, hits };
}

const start = async (config: Record<string, unknown>, endpoints: { method?: string; path: string; handler: never }[] = []) => {
  const app = await startTestApp({ config, endpoints });
  started.push(app);
  return app;
};
const from = async (path = "/invoices") => ((await http.service("billing" as never).get(path).send()) as { from: string }).from;

describe("options", () => {
  test("both url and discover, or neither, fail; discover without the registry native fails naming the fix", () => {
    const resolve = (config: Record<string, unknown>) => () => resolveConfig({ database: memoryAdapter(), ...config } as never, {});
    expect(resolve({ registry: {}, http: { services: { billing: { url: "http://b", discover: "billing" } } } })).toThrow("Invalid http.services.billing: set url or discover");
    expect(resolve({ registry: {}, http: { services: { billing: {} } } })).toThrow("Invalid http.services.billing: set url or discover");
    expect(resolve({ http: { services: { billing: { discover: "billing" } } } })).toThrow("http.services.billing.discover needs registry: {} in quickservicets.config.ts");
    expect(discoverSettings("billing")).toEqual({ name: "billing", balance: "round-robin", preferZone: true });
    expect(discoverSettings({ name: "billing", balance: "random" })).toEqual({ name: "billing", balance: "random", preferZone: true });
  });
});

describe("round-robin, SSRF trust and logs", () => {
  test("four calls go alternately to two static instances on private addresses, each http.call naming its instance", async () => {
    const a = upstream("a");
    const b = upstream("b");
    const app = await start({ registry: { register: false, services: { billing: { instances: [{ url: a.url }, { url: b.url }] } } }, http: { services: { billing: { discover: "billing" } } } });
    expect([await from(), await from(), await from(), await from()]).toEqual(["a", "b", "a", "b"]);
    expect(app.logs.filter((entry) => entry.message === "http.call").map((entry) => entry.instance)).toEqual(["billing-0", "billing-1", "billing-0", "billing-1"]);
  });

  test("an instance at the cloud metadata address stays blocked", async () => {
    await start({ registry: { register: false, services: { billing: { instances: [{ url: "http://169.254.169.254" }] } } }, http: { services: { billing: { discover: "billing" } } } });
    await expect(from()).rejects.toMatchObject({ code: "SSRF_BLOCKED" });
  });
});

/** A provider of a feature, whose instances and resolutions the test controls. */
function controlledProvider(initial: ServiceInstance[]) {
  const state = { instances: initial, resolves: 0, listeners: [] as ((instances: ServiceInstance[]) => void)[] };
  const provider: RegistryProvider = {
    register() {},
    heartbeat() {},
    deregister() {},
    resolve: () => (state.resolves++, state.instances),
  };
  return { state, provider };
}
const providerFeature = (provider: RegistryProvider) => ({ folder: "testregistry", definition: defineFeature({ key: "testregistry", enabledByDefault: true, requires: ["registry"], setup: (ctx) => ctx.feature("registry").setProvider(provider) }) });
const instance = (id: string, url: string, extra: Partial<ServiceInstance> = {}): ServiceInstance => ({ id, name: "billing", address: url, status: "passing", metadata: {}, ...extra });

describe("resolution cache and watches", () => {
  test("instances are resolved once per 5 seconds without a watch, and a watch updates them at once", async () => {
    const a = upstream("a");
    const b = upstream("b");
    const { state, provider } = controlledProvider([instance("a", a.url)]);
    let now = 1_000_000;
    setDiscoveryRandom(Math.random, () => now);
    registerProjectFeatures([providerFeature(provider)]);
    await start({ registry: { register: false }, http: { services: { billing: { discover: "billing" } } } });
    await from();
    await from();
    expect(state.resolves).toBe(1);
    state.instances = [instance("b", b.url)];
    expect(await from()).toBe("a");
    now += 5000;
    expect(await from()).toBe("b");
    expect(state.resolves).toBe(2);
    // A provider that watches pushes changes without waiting for the cache.
    await started.pop()!.stop();
    const listeners: ((instances: ServiceInstance[]) => void)[] = [];
    const watched: RegistryProvider = { ...provider, watch: (_name, onChange) => (listeners.push(onChange), () => {}) };
    registerProjectFeatures([providerFeature(watched)]);
    state.instances = [instance("a", a.url)];
    await start({ registry: { register: false }, http: { services: { billing: { discover: "billing" } } } });
    expect(await from()).toBe("a");
    listeners[0]!([instance("b", b.url)]);
    expect(await from()).toBe("b");
  });
});

describe("strategies and zones", () => {
  test("least-connections sends nothing new to an instance with two calls in flight while the other is idle", async () => {
    let slow = true;
    const a = upstream("a", { delay: () => (slow ? 300 : 0) });
    const b = upstream("b");
    await start({ registry: { register: false, services: { billing: { instances: [{ url: a.url }, { url: b.url }] } } }, http: { services: { billing: { discover: { name: "billing", balance: "least-connections" } } } } });
    // Two calls hold the slow instance, each picked when it had the fewest calls in flight.
    const first = from();
    const second = from();
    await Bun.sleep(20);
    expect([await from(), await from()]).toEqual(["b", "b"]);
    slow = false;
    expect((await Promise.all([first, second])).sort()).toEqual(["a", "b"]);
  });

  test("random follows the weights over 1000 picks within 5%", () => {
    const pool = [instance("a", "http://a", { weight: 1 }), instance("b", "http://b", { weight: 3 })];
    const settings = { name: "billing", balance: "random" as const, preferZone: true };
    let count = 0;
    for (let i = 0; i < 1000; i++) if (pickInstance("weights", settings, pool, new Set())!.id === "b") count++;
    expect(Math.abs(count / 1000 - 0.75)).toBeLessThan(0.05);
  });

  test("with zones a and b and the own zone a, calls go to zone a until its instance is critical", async () => {
    const a = upstream("a");
    const b = upstream("b");
    const { state, provider } = controlledProvider([instance("a", a.url, { zone: "a" }), instance("b", b.url, { zone: "b" })]);
    let now = 1_000_000;
    setDiscoveryRandom(Math.random, () => now);
    registerProjectFeatures([providerFeature(provider)]);
    await start({ registry: { register: false, zone: "a" }, http: { services: { billing: { discover: "billing" } } } });
    expect([await from(), await from(), await from()]).toEqual(["a", "a", "a"]);
    state.instances = [instance("a", a.url, { zone: "a", status: "critical" }), instance("b", b.url, { zone: "b" })];
    now += 5000;
    expect([await from(), await from()]).toEqual(["b", "b"]);
    expect(candidates(state.instances, { name: "billing", balance: "round-robin", preferZone: false }, "a").map((entry) => entry.id)).toEqual(["b"]);
  });
});

describe("retries, errors and proxy routes", () => {
  test("a retry after a 503 goes to the other instance, and both entries carry their instance", async () => {
    const a = upstream("a", { status: () => 503 });
    const b = upstream("b");
    const app = await start({ registry: { register: false, services: { billing: { instances: [{ url: a.url }, { url: b.url }] } } }, http: { services: { billing: { discover: "billing", retry: { backoff: "1ms" } } } } });
    expect(await from()).toBe("b");
    expect(app.logs.filter((entry) => entry.message === "http.call").map((entry) => [entry.instance, entry.status])).toEqual([["billing-0", 503], ["billing-1", 200]]);
  });

  test("no instance answers 503 with Retry-After: 5 from an endpoint, and a proxy route on the service balances across instances", async () => {
    const a = upstream("a");
    const b = upstream("b");
    const handler = (async (_repos: unknown, req: ServiceRequest) => req.http.service("empty" as never).get("/x").send()) as never;
    const app = await start(
      {
        registry: { register: false, services: { billing: { instances: [{ url: a.url }, { url: b.url }] } } },
        http: { services: { billing: { discover: "billing" }, empty: { discover: "nobody" } } },
        proxy: { routes: { billing: { path: "/billing", service: "billing" } } },
      },
      [{ path: "/call", handler }],
    );
    const unavailable = await app.fetch("/call");
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("retry-after")).toBe("5");
    expect(((await unavailable.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "SERVICE_UNAVAILABLE", message: "Upstream unavailable" });
    const proxied = [];
    for (let i = 0; i < 4; i++) proxied.push(((await (await app.fetch("/billing")).json()) as { from: string }).from);
    expect(proxied).toEqual(["a", "b", "a", "b"]);
  });
});
