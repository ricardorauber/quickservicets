import { afterEach, describe, expect, test } from "bun:test";
import "./index.ts";
import { defineFeature, registerProjectFeatures } from "./features.ts";
import { resolveConfig } from "./config.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { startTestApp, type TestApp } from "./tenancy-test-support.ts";
import { discoverSettings, http, isVersionRange, matchingInstances, type RegistryProvider, type ServiceInstance } from "./index.ts";
import { useTestResolver } from "./testing/index.ts";

const started: TestApp[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const restores: (() => void)[] = [];
afterEach(async () => {
  for (const app of started.splice(0)) await app.stop();
  for (const server of servers.splice(0)) server.stop(true);
  for (const restore of restores.splice(0)) restore();
  registerProjectFeatures([]);
});

/** An upstream answering its version. */
function upstream(version: string) {
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ version }) });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

const VERSIONS = ["1.4.0", "2.1.0", "2.3.0"];
const start = async (discover: unknown) => {
  const instances = VERSIONS.map((version) => ({ url: upstream(version), version }));
  const app = await startTestApp({ config: { registry: { register: false, services: { billing: { instances } } }, http: { services: { billing: { discover } } } } });
  started.push(app);
  return app;
};
const versions = async (count: number) => {
  const seen: string[] = [];
  for (let i = 0; i < count; i++) seen.push(((await http.service("billing" as never).get("/v").send()) as { version: string }).version);
  return seen;
};

describe("ranges", () => {
  test("name@range and the object form parse, and only ranges are valid", () => {
    expect(discoverSettings("billing@^2")).toMatchObject({ name: "billing", version: "^2" });
    expect(discoverSettings({ name: "billing", version: "~2.3", prefer: "highest" })).toMatchObject({ name: "billing", version: "~2.3", prefer: "highest" });
    for (const range of ["^2", "~2.3", ">=2.1 <3", ">= 2.1 < 3", "1.x || 2.x", "1.0.0 - 2.0.0", "*", "2.4.0-rc.1"]) expect(isVersionRange(range)).toBe(true);
    for (const range of ["banana", "", "^", "2.a", "|| 1"]) expect(isVersionRange(range)).toBe(false);
  });

  test("billing@banana fails startup with the range message", () => {
    expect(() => resolveConfig({ database: memoryAdapter(), registry: {}, http: { services: { billing: { discover: "billing@banana" } } } } as never, {})).toThrow("Invalid http.services.billing.discover: banana is not a version range");
  });
});

describe("matching", () => {
  test("billing@^2 sends calls to the two 2.x instances only", async () => {
    await start("billing@^2");
    expect((await versions(6)).sort()).toEqual(["2.1.0", "2.1.0", "2.1.0", "2.3.0", "2.3.0", "2.3.0"]);
  });

  test("a DNS instance without a version is excluded from billing@^2, and included with allowUnversioned", async () => {
    const address = new URL(upstream("dns")).port;
    restores.push(useTestResolver({ billing: "127.0.0.1" }));
    const run = async (discover: unknown) => {
      const app = await startTestApp({ config: { registry: { register: false, provider: "dns", dns: { port: Number(address) } }, http: { services: { billing: { discover } } } } });
      started.push(app);
      try {
        return await versions(1);
      } catch (error) {
        return [(error as Error).message];
      } finally {
        await started.pop()!.stop();
      }
    };
    expect(await run("billing@^2")).toEqual(["No instances of billing match ^2 (found no versions)"]);
    expect(await run({ name: "billing", version: "^2", allowUnversioned: true })).toEqual(["dns"]);
  });
});

describe("preference", () => {
  test("prefer highest sends calls only to the highest matching version", async () => {
    await start({ name: "billing", version: "^2", prefer: "highest" });
    expect(await versions(4)).toEqual(["2.3.0", "2.3.0", "2.3.0", "2.3.0"]);
    const instance = (version?: string): ServiceInstance => ({ id: version ?? "none", name: "billing", address: "http://x", status: "passing", metadata: {}, ...(version ? { version } : {}) });
    expect(matchingInstances([instance("1.0.0"), instance("1.2.0"), instance()], "^1", { prefer: "highest", allowUnversioned: true }).map((entry) => entry.id)).toEqual(["1.2.0"]);
  });
});

describe("errors and the own version", () => {
  test("billing@^4 fails listing the versions found", async () => {
    await start("billing@^4");
    await expect(versions(1)).rejects.toMatchObject({ code: "NO_INSTANCES", message: "No instances of billing match ^4 (found 1.4.0, 2.1.0, 2.3.0)" });
  });

  test("QS_REGISTRY_VERSION=2.4.0-rc.1 registers that version", async () => {
    const registered: ServiceInstance[] = [];
    const provider: RegistryProvider = { register: (instance) => void registered.push({ ...instance }), heartbeat() {}, deregister() {}, resolve: () => [] };
    registerProjectFeatures([{ folder: "testregistry", definition: defineFeature({ key: "testregistry", enabledByDefault: true, requires: ["registry"], setup: (ctx) => ctx.feature("registry").setProvider(provider) }) }]);
    const app = await startTestApp({ config: { registry: { version: "1.0.0" } }, env: { QS_REGISTRY_VERSION: "2.4.0-rc.1" } });
    started.push(app);
    expect(registered.map((instance) => instance.version)).toEqual(["2.4.0-rc.1"]);
  });
});
