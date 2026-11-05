import { afterEach, describe, expect, test } from "bun:test";
import "./index.ts";
import { fakeClock } from "./jobs/test-support.ts";
import { captureLogger } from "./jobs/test-support.ts";
import { startTestApp, type TestApp } from "./tenancy-test-support.ts";
import { currentRegistryProvider, dnsProvider, setRegistryClock, staticProvider } from "./index.ts";
import { useTestResolver } from "./testing/index.ts";

const started: TestApp[] = [];
const restores: (() => void)[] = [];
afterEach(async () => {
  for (const app of started.splice(0)) await app.stop();
  for (const restore of restores.splice(0)) restore();
  setRegistryClock();
});

const dns = (options: Partial<Parameters<typeof dnsProvider>[0]> = {}, clock = fakeClock()) => {
  const { logger, entries } = captureLogger();
  const provider = dnsProvider({ template: "{name}", records: "a", scheme: "http", refresh: "30s", ...options }, { logger, clock: () => clock });
  return { provider, entries, clock };
};

describe("static", () => {
  test("resolves two passing instances with their versions, ids and weights, and registers nothing", async () => {
    const provider = staticProvider({ billing: { instances: [{ url: "http://10.0.0.5:8080", version: "2.1.0", weight: 1 }, { url: "http://10.0.0.6:8080/", version: "1.4.0", weight: 3, zone: "b", metadata: { pool: "blue" } }] } });
    expect(await provider.resolve("billing")).toEqual([
      { id: "billing-0", name: "billing", version: "2.1.0", address: "http://10.0.0.5:8080", status: "passing", weight: 1, metadata: {} },
      { id: "billing-1", name: "billing", version: "1.4.0", address: "http://10.0.0.6:8080", status: "passing", zone: "b", weight: 3, metadata: { pool: "blue" } },
    ]);
    expect(await provider.resolve("nope")).toEqual([]);
    const instance = { id: "x", name: "x", address: "http://x", status: "passing", metadata: {} } as const;
    expect(provider.register(instance)).toBeUndefined();
    expect(provider.heartbeat(instance, "passing")).toBeUndefined();
    expect(provider.deregister(instance)).toBeUndefined();
  });
});

describe("dns a and aaaa", () => {
  test("the template with port 8080 and a test resolver answering two addresses gives two instances without versions", async () => {
    restores.push(useTestResolver({ "billing.default.svc.cluster.local": ["10.1.0.4", "fd00::5"] }));
    const { provider } = dns({ template: "{name}.default.svc.cluster.local", port: 8080 });
    const instances = await provider.resolve("billing");
    expect(instances.map((instance) => instance.address)).toEqual(["http://10.1.0.4:8080", "http://[fd00::5]:8080"]);
    expect(instances.every((instance) => instance.version === undefined && instance.status === "passing")).toBe(true);
    await provider.close?.();
  });

  test("a template whose host carries a port needs no dns.port, and without either the lookup fails", async () => {
    restores.push(useTestResolver({ billing: "10.1.0.4" }));
    expect((await dns({ template: "{name}:9000" }).provider.resolve("billing")).map((instance) => instance.address)).toEqual(["http://10.1.0.4:9000"]);
    await expect(Promise.resolve(dns().provider.resolve("billing"))).rejects.toThrow("registry.dns.port is required");
  });
});

describe("dns srv", () => {
  test("SRV answers with two targets give two instances with their ports and weights", async () => {
    restores.push(useTestResolver({ "_http._tcp.billing.svc": { srv: [{ name: "billing-0.billing.svc", port: 8080, weight: 10, priority: 0 }, { name: "billing-1.billing.svc.", port: 8081, weight: 5, priority: 0 }] } }));
    const { provider } = dns({ template: "{name}.svc", records: "srv", scheme: "https" });
    expect((await provider.resolve("billing")).map((instance) => [instance.address, instance.weight])).toEqual([
      ["https://billing-0.billing.svc:8080", 10],
      ["https://billing-1.billing.svc:8081", 5],
    ]);
    await provider.close?.();
  });
});

describe("caching and refresh", () => {
  test("results are kept for the larger of the TTL and refresh, refreshed in the background, and a failed refresh keeps the instances, logged once a minute", async () => {
    let answer: () => string[] = () => ["10.0.0.1"];
    let lookups = 0;
    restores.push(useTestResolver({ billing: () => (lookups++, { addresses: answer(), ttl: 60 }) }));
    const { provider, entries, clock } = dns({ port: 80, refresh: "30s" });
    expect((await provider.resolve("billing")).map((instance) => instance.address)).toEqual(["http://10.0.0.1:80"]);
    await provider.resolve("billing");
    expect(lookups).toBe(1);
    answer = () => ["10.0.0.2"];
    // The background refresh comes before the 60 s TTL ends.
    await clock.advance(54_000);
    expect(lookups).toBe(2);
    expect((await provider.resolve("billing")).map((instance) => instance.address)).toEqual(["http://10.0.0.2:80"]);
    answer = () => {
      throw new Error("SERVFAIL");
    };
    await clock.advance(54_000);
    await clock.advance(30_000);
    expect((await provider.resolve("billing")).map((instance) => instance.address)).toEqual(["http://10.0.0.2:80"]);
    expect(entries.filter((entry) => entry.message === "registry.dns.failed")).toEqual([expect.objectContaining({ level: "warn", service: "billing", reason: "SERVFAIL" })]);
    await clock.advance(30_000);
    expect(entries.filter((entry) => entry.message === "registry.dns.failed")).toHaveLength(2);
    await provider.close?.();
    expect(clock.timers()).toBe(0);
  });
});

describe("variables", () => {
  test("QS_REGISTRY_SERVICES defines the static record and QS_REGISTRY_DNS_RECORDS switches the lookup", async () => {
    const app = await startTestApp({ config: { registry: { register: false } }, env: { QS_REGISTRY_SERVICES: '{"billing":{"instances":[{"url":"http://b:80"}]}}' } });
    started.push(app);
    expect(await currentRegistryProvider()!.resolve("billing")).toMatchObject([{ id: "billing-0", address: "http://b:80", status: "passing", weight: 1 }]);
    await started.pop()!.stop();
    restores.push(useTestResolver({ "_http._tcp.billing": { srv: [{ name: "b1", port: 7000, weight: 1, priority: 0 }] } }));
    const dnsApp = await startTestApp({ config: { registry: { register: false } }, env: { QS_REGISTRY_PROVIDER: "dns", QS_REGISTRY_DNS_RECORDS: "srv", QS_REGISTRY_DNS_TEMPLATE: "{name}", QS_REGISTRY_DNS_REFRESH: "1m" } });
    started.push(dnsApp);
    expect((await currentRegistryProvider()!.resolve("billing")).map((instance) => instance.address)).toEqual(["http://b1:7000"]);
    expect(dnsApp.config.features.find((feature) => feature.key === "registry")!.options).toMatchObject({ provider: "dns", dns: { records: "srv", refresh: "1m" } });
  });
});
