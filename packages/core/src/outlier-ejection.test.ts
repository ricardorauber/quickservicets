import { afterEach, describe, expect, test } from "bun:test";
import "./index.ts";
import { defineFeature, registerProjectFeatures } from "./features.ts";
import { fakeClock } from "./jobs/test-support.ts";
import { startTestApp, type TestApp } from "./tenancy-test-support.ts";
import { http, setOutlierClock, type RegistryProvider, type ServiceInstance } from "./index.ts";

const started: TestApp[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const app of started.splice(0)) await app.stop();
  for (const server of servers.splice(0)) server.stop(true);
  registerProjectFeatures([]);
  setOutlierClock();
});

/** An upstream answering its name with the status `status()` gives; its ready route answers `ready()`. */
function upstream(name: string, options: { status?: () => number; ready?: () => number } = {}) {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/health/ready") return new Response(null, { status: options.ready?.() ?? 200 });
      return Response.json({ from: name }, { status: options.status?.() ?? 200 });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

const start = async (config: Record<string, unknown>) => {
  const app = await startTestApp({ config });
  started.push(app);
  return app;
};
const staticConfig = (a: string, b: string, service: Record<string, unknown> = {}) => ({
  registry: { register: false, services: { billing: { instances: [{ url: a }, { url: b }] } } },
  http: { services: { billing: { discover: "billing", ...service } } },
});
/** Calls the service and resolves who answered, or the status of a failure. */
const call = async () => {
  const response = await http.service("billing" as never).get("/x").response();
  return response.ok ? ((await response.json()) as { from: string }).from : `${response.status}`;
};
const calls = async (count: number) => {
  const answers: string[] = [];
  for (let i = 0; i < count; i++) answers.push(await call());
  return answers;
};

describe("passive ejection and backoff", () => {
  test("five failed calls eject an instance for 30 seconds, it returns after them, and a new failure ejects it for 60 seconds", async () => {
    const clock = fakeClock();
    setOutlierClock(clock);
    const app = await start(staticConfig(upstream("a", { status: () => 500 }), upstream("b")));
    // Round-robin alternates until the fifth failure of a ejects it; then every call goes to b.
    expect(await calls(10)).toEqual(["500", "b", "500", "b", "500", "b", "500", "b", "500", "b"]);
    expect(await calls(3)).toEqual(["b", "b", "b"]);
    const ejected = app.logs.filter((entry) => entry.message === "registry.instance.ejected");
    expect(ejected).toEqual([expect.objectContaining({ level: "warn", service: "billing", instance: "billing-0", failures: 5, until: new Date(clock.now() + 30_000).toISOString() })]);
    await clock.advance(30_000);
    expect((await calls(2)).sort()).toEqual(["500", "b"]);
    expect(app.logs.filter((entry) => entry.message === "registry.instance.restored")).toEqual([expect.objectContaining({ service: "billing", instance: "billing-0" })]);
    expect(app.logs.filter((entry) => entry.message === "registry.instance.ejected").at(-1)).toMatchObject({ failures: 1, until: new Date(clock.now() + 60_000).toISOString() });
  });

  test("4xx answers never eject an instance", async () => {
    await start(staticConfig(upstream("a", { status: () => 404 }), upstream("b")));
    expect(await calls(14)).toEqual(Array.from({ length: 14 }, (_, index) => (index % 2 === 0 ? "404" : "b")));
  });
});

describe("limits and panic", () => {
  test("with both instances failing only one is ejected (50%)", async () => {
    const app = await start(staticConfig(upstream("a", { status: () => 503 }), upstream("b", { status: () => 503 })));
    await calls(20);
    expect(app.logs.filter((entry) => entry.message === "registry.instance.ejected")).toHaveLength(1);
  });

  test("with both instances critical in the registry, calls still go to both with one registry.panic entry", async () => {
    const instances: ServiceInstance[] = [
      { id: "a", name: "billing", address: upstream("a"), status: "critical", metadata: {} },
      { id: "b", name: "billing", address: upstream("b"), status: "critical", metadata: {} },
    ];
    const provider: RegistryProvider = { register() {}, heartbeat() {}, deregister() {}, resolve: () => instances };
    registerProjectFeatures([{ folder: "testregistry", definition: defineFeature({ key: "testregistry", enabledByDefault: true, requires: ["registry"], setup: (ctx) => ctx.feature("registry").setProvider(provider) }) }]);
    const app = await start({ registry: { register: false }, http: { services: { billing: { discover: "billing" } } } });
    expect((await calls(4)).sort()).toEqual(["a", "a", "b", "b"]);
    expect(app.logs.filter((entry) => entry.message === "registry.panic")).toEqual([expect.objectContaining({ service: "billing" })]);
  });
});

describe("active probes", () => {
  test("an instance whose ready route answers 503 is ejected before any call fails", async () => {
    const clock = fakeClock();
    setOutlierClock(clock);
    const app = await start(staticConfig(upstream("a", { status: () => 500, ready: () => 503 }), upstream("b"), { probe: { interval: "10s" } }));
    for (let round = 0; round < 5; round++) {
      await clock.advance(10_000);
      await Bun.sleep(30);
    }
    expect(app.logs.filter((entry) => entry.message === "registry.instance.ejected")).toEqual([expect.objectContaining({ instance: "billing-0", failures: 5 })]);
    expect(await calls(4)).toEqual(["b", "b", "b", "b"]);
  });
});

describe("state and logs", () => {
  test("http.state(name).instances shows the ejected instance with ejectedUntil", async () => {
    const clock = fakeClock();
    setOutlierClock(clock);
    const a = upstream("a", { status: () => 502 });
    await start(staticConfig(a, upstream("b"), { outlier: { failures: 2 } }));
    await calls(4);
    const state = http.state("billing").instances!;
    expect(state).toEqual([
      { id: "billing-0", address: a, state: "ejected", inFlight: 0, failures: 0, ejectedUntil: new Date(clock.now() + 30_000) },
      expect.objectContaining({ id: "billing-1", state: "ok", inFlight: 0, failures: 0 }),
    ]);
  });
});
