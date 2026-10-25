import { afterEach, describe, expect, test } from "bun:test";
import { memoryAdapter } from "./adapters/memory.ts";
import { normalizeAddress } from "./cidr.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { createServer, peerAddress, type Route, type ServerSettings } from "./http/server.ts";
import { createFeatureLifecycle } from "./lifecycle.ts";
import type { LogEntry } from "./logger.ts";
import { clientBehindProxies } from "./features/security/proxy.ts";
// Loading the core registers the natives it ships.
import "./index.ts";

const logs: LogEntry[] = [];
const logger = { info: (entry: LogEntry) => void logs.push(entry), warn: (entry: LogEntry) => void logs.push(entry), error: (entry: LogEntry) => void logs.push(entry) };
afterEach(() => {
  logs.length = 0;
});

const ipRoute: Route = { method: "GET", path: "/ip", handler: (_repos, req) => ({ ip: req.ip }) };

/** The server settings the enabled features give for a configuration. */
async function settingsOf(config: Record<string, unknown>, env: Record<string, string> = {}): Promise<ServerSettings> {
  const resolved = resolveConfig({ database: memoryAdapter(), logger, ...config } as ServiceConfig, env);
  const lifecycle = createFeatureLifecycle({ features: resolved.features, config: resolved, models: [], worker: { index: 0, count: 1, runsScheduledWork: true } });
  await lifecycle.setup();
  return lifecycle.server;
}

const serve = (settings: ServerSettings = {}, routes: Route[] = [ipRoute]) => createServer({ routes, repos: {}, config: { production: false, logger }, ...settings });
const ipOf = async (server: ReturnType<typeof serve>, peer: string | undefined, headers: Record<string, string> = {}) =>
  ((await (await server.fetch(new Request("http://localhost/ip", { headers }), peer === undefined ? undefined : { peer })).json()) as { ip: string }).ip;

describe("peer address", () => {
  test("a test peer becomes req.ip and peerAddress, and a request without one is unknown", async () => {
    const server = serve();
    const request = new Request("http://localhost/ip");
    expect(await (await server.fetch(request, { peer: "203.0.113.5" })).json()).toEqual({ ip: "203.0.113.5" });
    expect(peerAddress(request)).toBe("203.0.113.5");
    expect(await ipOf(server, undefined)).toBe("unknown");
    expect(peerAddress(new Request("http://localhost/"))).toBe("unknown");
  });

  test("a listening server reads the socket address", async () => {
    const listening = serve().listen(0);
    try {
      const { ip } = (await (await fetch(`http://127.0.0.1:${listening.port}/ip`)).json()) as { ip: string };
      expect(ip).toBe("127.0.0.1");
    } finally {
      await listening.stop(true);
    }
  });

  test("with security: false, req.ip is still the peer address", async () => {
    const settings = await settingsOf({ security: false });
    expect(settings.clientIp).toBeUndefined();
    expect(await ipOf(serve(settings), "198.51.100.1", { "x-forwarded-for": "1.2.3.4" })).toBe("198.51.100.1");
  });
});

describe("trusted proxies", () => {
  test("from a trusted peer, the right-most untrusted address of x-forwarded-for; from another peer, the peer", async () => {
    const server = serve(await settingsOf({ security: { proxy: { trust: ["10.0.0.0/8"] } } }));
    expect(await ipOf(server, "10.0.0.2", { "x-forwarded-for": "198.51.100.7, 10.0.0.9" })).toBe("198.51.100.7");
    expect(await ipOf(server, "203.0.113.5", { "x-forwarded-for": "198.51.100.7, 10.0.0.9" })).toBe("203.0.113.5");
    // Every listed address trusted: the left-most one.
    expect(await ipOf(server, "10.0.0.2", { "x-forwarded-for": "10.1.1.1, 10.0.0.9" })).toBe("10.1.1.1");
    expect(await ipOf(server, "10.0.0.2")).toBe("10.0.0.2");
  });

  test("the forwarded header's for= parameters, and a custom header read as a list", async () => {
    const forwarded = serve(await settingsOf({ security: { proxy: { trust: ["10.0.0.0/8"], header: "forwarded" } } }));
    expect(await ipOf(forwarded, "10.0.0.2", { forwarded: 'for=198.51.100.7;proto=https, for="[2001:db8::1]:4711"' })).toBe("2001:db8::1");
    const custom = serve(await settingsOf({ security: { proxy: { trust: ["loopback"], header: "x-real-chain" } } }));
    expect(await ipOf(custom, "127.0.0.1", { "x-real-chain": "198.51.100.8" })).toBe("198.51.100.8");
  });

  test("the environment sets the trusted proxies", async () => {
    const server = serve(await settingsOf({}, { QS_SECURITY_PROXY_TRUST: "10.0.0.0/8,192.168.0.0/16" }));
    expect(await ipOf(server, "192.168.1.1", { "x-forwarded-for": "198.51.100.9" })).toBe("198.51.100.9");
  });
});

describe("normalization", () => {
  test("mapped IPv4, IPv6 case and compression, brackets and ports", () => {
    expect(normalizeAddress("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(normalizeAddress("2001:DB8:0:0:0:0:0:1")).toBe("2001:db8::1");
    expect(normalizeAddress("[2001:db8::1]:4711")).toBe("2001:db8::1");
    expect(normalizeAddress("198.51.100.7:8080")).toBe("198.51.100.7");
    expect(normalizeAddress("2001:db8:0:1:0:0:0:1")).toBe("2001:db8:0:1::1");
    expect(normalizeAddress("garbage")).toBeUndefined();
  });

  test("an invalid entry stops the walk at the address after it", async () => {
    const trusted = (address: string) => address.startsWith("10.");
    expect(clientBehindProxies("198.51.100.7, garbage, 10.0.0.9", "x-forwarded-for", "10.0.0.2", trusted)).toBe("10.0.0.9");
    expect(clientBehindProxies("garbage", "x-forwarded-for", "10.0.0.2", trusted)).toBe("10.0.0.2");
    const server = serve(await settingsOf({ security: { proxy: { trust: ["10.0.0.0/8"] } } }));
    expect(await ipOf(server, "::ffff:10.0.0.2", { "x-forwarded-for": "::ffff:198.51.100.7" })).toBe("198.51.100.7");
  });
});

describe("warning and lazy computation", () => {
  test("in production, forwarded headers from an untrusted peer log one warning per worker", async () => {
    const server = serve(await settingsOf({ production: true }));
    expect(await ipOf(server, "203.0.113.5", { "x-forwarded-for": "1.2.3.4" })).toBe("203.0.113.5");
    expect(await ipOf(server, "203.0.113.6", { "x-forwarded-for": "1.2.3.5" })).toBe("203.0.113.6");
    const warnings = logs.filter((entry) => entry.message === "security.proxy.untrusted");
    expect(warnings).toEqual([expect.objectContaining({ peer: "203.0.113.5", hint: "set security.proxy.trust if the service runs behind a proxy" })]);
    // Outside production nothing is logged and no resolver runs.
    expect((await settingsOf({})).clientIp).toBeUndefined();
  });

  test("a request that never reads req.ip never calls the resolver", async () => {
    let calls = 0;
    const server = serve({ clientIp: (_request, peer) => (calls++, peer) }, [ipRoute, { method: "GET", path: "/quiet", handler: () => ({ ok: true }) }]);
    await server.fetch(new Request("http://localhost/quiet"), { peer: "203.0.113.5" });
    expect(calls).toBe(0);
    await ipOf(server, "203.0.113.5");
    expect(calls).toBe(1);
  });
});
