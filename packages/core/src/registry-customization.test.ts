import { afterEach, describe, expect, test } from "bun:test";
import "./index.ts";
import { registerProjectFeatures } from "./features.ts";
import { startTestApp, type TestApp } from "./tenancy-test-support.ts";
import { dnsProvider, http, setDiscoveryRandom, staticProvider, type InstanceChange, type RegistryProvider, type ServiceInstance, type ServiceRequest } from "./index.ts";
import { checkRegistryProvider, runRegistryProviderContract, useTestResolver } from "./testing/index.ts";

const started: TestApp[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const app of started.splice(0)) await app.stop();
  for (const server of servers.splice(0)) server.stop(true);
  registerProjectFeatures([]);
  setDiscoveryRandom();
});

function upstream(name: string) {
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ from: name }) });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}
const start = async (config: Record<string, unknown>, env: Record<string, string> = {}, endpoints: { path: string; handler: never }[] = []) => {
  const app = await startTestApp({ config, env, endpoints });
  started.push(app);
  return app;
};
const from = async () => ((await http.service("billing" as never).get("/").send()) as { from: string }).from;

describe("level 0 and variables", () => {
  test("registry: {} with static services discovers them, and QS_REGISTRY_ZONE changes the own zone preferZone uses", async () => {
    const services = { billing: { instances: [{ url: upstream("a"), zone: "a" }, { url: upstream("b"), zone: "b" }] } };
    await start({ registry: { services }, http: { services: { billing: { discover: "billing" } } } });
    expect([await from(), await from()]).toEqual(["a", "b"]);
    await started.pop()!.stop();
    await start({ registry: { services }, http: { services: { billing: { discover: "billing" } } } }, { QS_REGISTRY_ZONE: "b" });
    expect([await from(), await from(), await from()]).toEqual(["b", "b", "b"]);
    await started.pop()!.stop();
    const app = await start({ registry: { services: { ...services, other: services.billing } }, http: { services: { billing: { discover: "other" } } } }, { QS_HTTP_SERVICES_BILLING_DISCOVER: "billing" });
    expect(app.config.features.find((feature) => feature.key === "http")!.options.services).toMatchObject({ billing: { discover: "billing" } });
  });
});

describe("per-request discovery", () => {
  test("a discover function routes acme's requests to the 3.x instances only, and others to 2.x", async () => {
    const instances = [{ url: upstream("v2"), version: "2.5.0" }, { url: upstream("v3"), version: "3.1.0" }];
    const handler = (async (_repos: unknown, req: ServiceRequest) => req.http.service("billing" as never).get("/").send()) as never;
    const app = await start(
      {
        tenancy: { source: "config", tenants: { acme: {}, globex: {} } },
        registry: { register: false, services: { billing: { instances } } },
        http: { services: { billing: { discover: ({ tenant }: { tenant?: { id: string } }) => (tenant?.id === "acme" ? "billing@^3" : "billing@^2") } } },
      },
      {},
      [{ path: "/call", handler }],
    );
    const as = async (tenant: string) => ((await (await app.fetch("/call", { headers: { "x-tenant-id": tenant } })).json()) as { from: string }).from;
    expect([await as("acme"), await as("acme"), await as("globex"), await as("globex")]).toEqual(["v3", "v3", "v2", "v2"]);
  });
});

describe("hooks", () => {
  test("beforeRegister's metadata reaches the provider, and onInstanceDown fires when an instance leaves the resolution", async () => {
    const registered: ServiceInstance[] = [];
    const a = upstream("a");
    const b = upstream("b");
    let instances: ServiceInstance[] = [
      { id: "a", name: "billing", address: a, status: "passing", metadata: {} },
      { id: "b", name: "billing", address: b, status: "passing", metadata: {} },
    ];
    const provider: RegistryProvider = { register: (instance) => void registered.push(instance), heartbeat() {}, deregister() {}, resolve: () => instances };
    const changes: string[] = [];
    let now = 1_000_000;
    setDiscoveryRandom(Math.random, () => now);
    await start({
      registry: {
        provider,
        beforeRegister: (instance: ServiceInstance) => ({ metadata: { ...instance.metadata, build: "42" } }),
        onInstanceUp: ({ instance }: InstanceChange) => void changes.push(`up ${instance.id}`),
        onInstanceDown: ({ service, instance }: InstanceChange) => void changes.push(`down ${service} ${instance.id}`),
      },
      http: { services: { billing: { discover: "billing" } } },
    });
    expect(registered.map((instance) => instance.metadata)).toEqual([{ build: "42" }]);
    await from();
    instances = instances.slice(0, 1);
    now += 5000;
    await from();
    await Bun.sleep(5);
    expect(changes).toEqual(["up a", "up b", "down billing b"]);
  });
});

describe("provider and balancer objects", () => {
  test("a project provider object resolves the instances and a balancer always picking the first is used", async () => {
    const a = upstream("a");
    const b = upstream("b");
    const provider: RegistryProvider = {
      register() {},
      heartbeat() {},
      deregister() {},
      resolve: () => [
        { id: "a", name: "billing", address: a, status: "passing", metadata: {} },
        { id: "b", name: "billing", address: b, status: "passing", metadata: {} },
      ],
    };
    await start({ registry: { provider, register: false }, http: { services: { billing: { discover: "billing", balancer: { pick: (instances: ServiceInstance[]) => instances[0]! } } } } });
    expect([await from(), await from(), await from()]).toEqual(["a", "a", "a"]);
  });
});

describe("the contract kit", () => {
  const instance: ServiceInstance = { id: "billing-host-1", name: "billing", address: "http://10.0.0.9:8080", status: "passing", metadata: {} };

  test("a provider that leaves a timer after close fails the contract", async () => {
    const leaking = (): RegistryProvider => {
      const base = staticProvider({ billing: { instances: [{ url: "http://10.0.0.5:8080", weight: 1 }] } });
      return { ...base, resolve: (name) => (setInterval(() => {}, 60_000), base.resolve(name)) };
    };
    const failures = await checkRegistryProvider(leaking, { fixtures: { instance, service: "billing" } });
    expect(failures.map((failure) => failure.check)).toEqual(["leaves no timers after close()"]);
  });
});

runRegistryProviderContract(() => staticProvider({ billing: { instances: [{ url: "http://10.0.0.5:8080", version: "2.1.0", weight: 1 }, { url: "http://10.0.0.6:8080", version: "1.4.0", weight: 1 }] } }), {
  name: "static provider",
  fixtures: { instance: { id: "billing-host-1", name: "billing", address: "http://10.0.0.9:8080", status: "passing", metadata: {} }, service: "billing", versions: ["1.4.0", "2.1.0"] },
});

let restore: () => void = () => {};
runRegistryProviderContract(
  () => {
    restore();
    restore = useTestResolver({ "billing.svc": ["10.1.0.4", "10.1.0.5"] });
    return dnsProvider({ template: "{name}.svc", records: "a", port: 8080, scheme: "http", refresh: "30s" }, { logger: { info() {}, warn() {}, error() {} }, clock: () => ({ now: Date.now, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (handle) => clearTimeout(handle as never) }) });
  },
  { name: "dns provider", fixtures: { instance: { id: "billing-host-1", name: "billing", address: "http://10.0.0.9:8080", status: "passing", metadata: {} }, service: "billing", versions: ["", ""] } },
);
