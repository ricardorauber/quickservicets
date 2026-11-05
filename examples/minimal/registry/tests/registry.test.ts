import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { http, registerProjectFeatures, setOutlierClock, type JobClock } from "@quickservicets/core";
import { useTestResolver } from "@quickservicets/core/testing";
import { startTestService, type TestService } from "@quickservicets/cli/testing";
import { startUpstream } from "../scripts/upstream.ts";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const files = (extra: Record<string, string> = {}) => ({
  "quickservicets.config.ts": read("quickservicets.config.ts"),
  "endpoints/invoices/get.ts": read("endpoints/invoices/get.ts"),
  ...extra,
});

const upstreams: ReturnType<typeof startUpstream>[] = [];
const services: TestService[] = [];
const restores: (() => void)[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  for (const upstream of upstreams.splice(0)) upstream.stop();
  for (const restore of restores.splice(0)) restore();
  // Each service registers its project features; none leaks into the next test.
  registerProjectFeatures([]);
  setOutlierClock();
});

/** The two billing instances on free ports, as QS_REGISTRY_SERVICES describes them. */
function billing() {
  const v1 = startUpstream({ version: "1.4.0" });
  const v2 = startUpstream({ version: "2.1.0" });
  upstreams.push(v1, v2);
  const env = { QS_REGISTRY_SERVICES: JSON.stringify({ billing: { instances: [{ url: v1.url, version: "1.4.0" }, { url: v2.url, version: "2.1.0" }] } }) };
  return { v1, v2, env };
}

const start = async (env: Record<string, string>, extra: Record<string, string> = {}) => {
  const service = await startTestService({ files: files(extra), env });
  services.push(service);
  return service;
};
const versions = async (service: TestService, count: number) => {
  const seen: string[] = [];
  for (let i = 0; i < count; i++) {
    const response = await service.fetch("/invoices");
    seen.push(response.ok ? ((await response.json()) as { version: string }).version : String(response.status));
  }
  return seen;
};

/** A clock whose timers fire when the test advances it. */
function manualClock() {
  let now = Date.now();
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 0;
  const clock: JobClock & { advance(ms: number): void } = {
    now: () => now,
    setTimeout: (fn, ms) => (timers.set(++next, { at: now + ms, fn }), next),
    clearTimeout: (handle) => void timers.delete(handle as number),
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) (timers.delete(id), timer.fn());
    },
  };
  return clock;
}

describe("static discovery", () => {
  test("GET /invoices answers through the 2.x instance only", async () => {
    const { env } = billing();
    expect(await versions(await start(env), 4)).toEqual(["2.1.0", "2.1.0", "2.1.0", "2.1.0"]);
  });

  test("without a range calls go round-robin across both instances, and ^1 selects 1.4.0", async () => {
    const { env } = billing();
    expect((await versions(await start({ ...env, QS_HTTP_SERVICES_BILLING_DISCOVER: "billing" }), 4)).sort()).toEqual(["1.4.0", "1.4.0", "2.1.0", "2.1.0"]);
    expect(await versions(await start({ ...env, QS_HTTP_SERVICES_BILLING_DISCOVER: "billing@^1" }), 3)).toEqual(["1.4.0", "1.4.0", "1.4.0"]);
  });

  test("a range no instance matches answers 503 with Retry-After", async () => {
    const { env } = billing();
    const response = await (await start({ ...env, QS_HTTP_SERVICES_BILLING_DISCOVER: "billing@^4" })).fetch("/invoices");
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
  });
});

describe("ejection", () => {
  test("the failing instance is ejected, calls go to the other one, and it returns after its ejection time", async () => {
    const clock = manualClock();
    setOutlierClock(clock);
    const { v2, env } = billing();
    const service = await start({ ...env, QS_HTTP_SERVICES_BILLING_DISCOVER: "billing" });
    v2.fail();
    // Retries move each failed attempt to 1.4.0, so every call answers while 2.1.0 collects failures.
    expect(new Set(await versions(service, 10))).toEqual(new Set(["1.4.0"]));
    const ejected = () => http.state("billing").instances?.find((instance) => instance.state === "ejected")?.id;
    expect(ejected()).toBe("billing-1");
    v2.recover();
    clock.advance(30_000);
    expect(ejected()).toBeUndefined();
    expect((await versions(service, 4)).sort()).toEqual(["1.4.0", "1.4.0", "2.1.0", "2.1.0"]);
  });
});

describe("dns discovery", () => {
  test("the dns provider finds the instance through a test resolver", async () => {
    const { v2 } = billing();
    restores.push(useTestResolver({ "billing.default.svc.cluster.local": "127.0.0.1" }));
    const env = { QS_REGISTRY_PROVIDER: "dns", QS_REGISTRY_DNS_TEMPLATE: "{name}.default.svc.cluster.local", QS_REGISTRY_DNS_PORT: String(v2.port), QS_HTTP_SERVICES_BILLING_DISCOVER: "billing" };
    expect(await versions(await start(env), 2)).toEqual(["2.1.0", "2.1.0"]);
  });
});

const CONSUL_CONFIG = (url: string) => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
import { registryConsul } from "./providers/consul.ts";

export default defineConfig({
  database: memoryAdapter(),
  registry: { name: "invoices", address: "http://10.0.0.9:3000", provider: registryConsul({ url: ${JSON.stringify(url)} }) },
  http: { services: { billing: { discover: "billing@^2" } } },
});
`;

describe("consul", () => {
  test("registration and resolution go through Consul's HTTP API, answered by http.mock()", async () => {
    const mock = http.mock();
    try {
      mock.on("PUT", "http://consul.test:8500/v1/agent/*").reply(200, {});
      mock.on("GET", "http://consul.test:8500/v1/health/service/billing").reply(200, [
        { Service: { ID: "billing-1", Service: "billing", Address: "billing-1.test", Port: 9000, Meta: { version: "2.1.0" } }, Checks: [{ Status: "passing" }] },
      ]);
      mock.on("GET", "http://billing-1.test:9000/invoices").reply(200, { version: "2.1.0" });
      const service = await start({}, { "quickservicets.config.ts": CONSUL_CONFIG("http://consul.test:8500"), "providers/consul.ts": read("providers/consul.ts") });
      expect(await versions(service, 1)).toEqual(["2.1.0"]);
      const register = mock.calls.find((call) => call.url.endsWith("/v1/agent/service/register"));
      expect(JSON.parse(register!.body)).toMatchObject({ Name: "invoices", Address: "10.0.0.9", Port: 3000 });
    } finally {
      mock.restore();
    }
  });

  test.skipIf(!process.env.TEST_CONSUL_URL)("registers with a real Consul agent and resolves through it (TEST_CONSUL_URL)", async () => {
    const { v2 } = billing();
    const url = process.env.TEST_CONSUL_URL!;
    const { registryConsul } = await import("../providers/consul.ts");
    const consul = registryConsul({ url });
    const instance = { id: "billing-test-1", name: "billing", address: v2.url, version: "2.1.0", status: "passing" as const, metadata: {} };
    await consul.register(instance);
    await consul.heartbeat(instance, "passing");
    try {
      expect((await consul.resolve("billing")).map((found) => found.id)).toContain("billing-test-1");
    } finally {
      await consul.deregister(instance);
    }
  });
});
