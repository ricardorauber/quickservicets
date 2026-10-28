import { afterEach, describe, expect, test } from "bun:test";
import { startTestService, type TestService } from "../testing/service.ts";

const CONFIG = (security: string, head = "", extra = "") => `import { databaseIpList, defineConfig, memoryAdapter } from "@quickservicets/core";
${head}
export default defineConfig({
  database: memoryAdapter(),
  logger: {
    info: (entry: object) => void ((globalThis as any).ipLogs ??= []).push(entry),
    warn: (entry: object) => void ((globalThis as any).ipLogs ??= []).push(entry),
    error: (entry: object) => void ((globalThis as any).ipLogs ??= []).push(entry),
  },
  security: ${security},
  ${extra}
});
`;
type Global = { ipLogs?: Record<string, unknown>[]; ipSource?: { deny: string[]; allow: string[]; fail?: boolean } };
const global = globalThis as Global;
const logs = () => (global.ipLogs ??= []);
/** A source reading the lists the test puts in a global. */
const SOURCE = `const source = { async load() { const lists = (globalThis as any).ipSource; if (lists.fail) throw new Error("feed down"); return { allow: [...lists.allow], deny: [...lists.deny] }; } };`;

const running: TestService[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
  logs().length = 0;
  delete global.ipSource;
});

async function start(security: string, options: { head?: string; extra?: string; files?: Record<string, string>; env?: Record<string, string> } = {}) {
  const service = await startTestService({ files: { "quickservicets.config.ts": CONFIG(security, options.head, options.extra), ...options.files }, ...(options.env ? { env: options.env } : {}) });
  running.push(service);
  return service;
}
const from = (peer: string) => ({ peer });

describe("a source", () => {
  test("loaded lists refuse from the first request while the config lists still apply, and a failing first load keeps the config lists", async () => {
    global.ipSource = { allow: [], deny: ["203.0.113.0/24"] };
    const service = await start(`{ ip: { deny: ["198.51.100.7"], source } }`, { head: SOURCE, files: { "endpoints/ping/get.ts": "export default () => ({ ok: true });\n" } });
    const refused = await service.fetch("/ping", from("203.0.113.9"));
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toBe("Address not allowed");
    expect((await service.fetch("/ping", from("198.51.100.7"))).status).toBe(403);
    expect((await service.fetch("/ping", from("192.0.2.1"))).status).toBe(200);
    await service.stop();
    running.length = 0;

    global.ipSource = { allow: [], deny: ["203.0.113.0/24"], fail: true };
    const failing = await start(`{ ip: { deny: ["198.51.100.7"], source } }`, { head: SOURCE, files: { "endpoints/ping/get.ts": "export default () => ({ ok: true });\n" } });
    expect((await failing.fetch("/ping", from("203.0.113.9"))).status).toBe(200);
    expect((await failing.fetch("/ping", from("198.51.100.7"))).status).toBe(403);
    expect(logs().filter((entry) => entry.message === "security.ip.source.failed")).toEqual([expect.objectContaining({ reason: "feed down" })]);
  });

  test("ip.reload() from a project feature applies a changed list before it resolves, and rejects with a failing load", async () => {
    global.ipSource = { allow: [], deny: [] };
    const feature = `import { defineFeature, HttpError } from "@quickservicets/core";
export default defineFeature({
  key: "ipadmin",
  requires: ["security"],
  setup(ctx) {
    const security = ctx.feature("security");
    ctx.app.route("POST", "/admin/ip-reload", async () => {
      try {
        return await security.ip.reload();
      } catch (error) {
        throw new HttpError(502, (error as Error).message);
      }
    });
  },
});
`;
    const service = await start(`{ ip: { source } }`, { head: SOURCE, extra: "ipadmin: {},", files: { "features/ipadmin/index.ts": feature, "endpoints/ping/get.ts": "export default () => ({ ok: true });\n" } });
    expect((await service.fetch("/ping", from("203.0.113.9"))).status).toBe(200);
    global.ipSource.deny = ["203.0.113.9"];
    expect(await (await service.fetch("/admin/ip-reload", { method: "POST" })).json()).toEqual({ allow: 0, deny: 1 });
    expect((await service.fetch("/ping", from("203.0.113.9"))).status).toBe(403);
    global.ipSource.fail = true;
    const failed = await service.fetch("/admin/ip-reload", { method: "POST" });
    expect(failed.status).toBe(502);
    expect((await service.fetch("/ping", from("203.0.113.9"))).status).toBe(403);
  });

  test("without a source no timer runs; with one, the refresh timer does", async () => {
    const original = globalThis.setInterval;
    const delays: unknown[] = [];
    globalThis.setInterval = ((fn: () => void, ms?: number, ...rest: unknown[]) => (delays.push(ms), original(fn, ms, ...rest))) as typeof setInterval;
    try {
      await start(`{ ip: { deny: ["198.51.100.7"], refresh: "47s" } }`);
      expect(delays).not.toContain(47_000);
      global.ipSource = { allow: [], deny: [] };
      await start(`{ ip: { source, refresh: "47s" } }`, { head: SOURCE });
      expect(delays).toContain(47_000);
    } finally {
      globalThis.setInterval = original;
    }
  });
});

describe("databaseIpList", () => {
  const RULE = `export type IpRule = {
  cidr: string;
  list: "allow" | "deny";
  expiresAt?: Date;
  note?: string;
};
`;
  test("a deny rule written through the CRUD routes refuses its address on the next request, an expired rule is ignored, and a wrong entity fails startup", async () => {
    const service = await start(`{ ip: { source: databaseIpList({ entity: "IpRule" }), refresh: "1h" } }`, { files: { "entities/IpRule.ts": RULE } });
    expect((await service.fetch("/ip-rules", from("203.0.113.9"))).status).toBe(200);
    const created = await service.fetch("/ip-rules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cidr: "203.0.113.9", list: "deny" }) });
    expect(created.status).toBe(201);
    expect((await service.fetch("/ip-rules", from("203.0.113.9"))).status).toBe(403);
    const expired = await service.fetch("/ip-rules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cidr: "198.51.100.4", list: "deny", expiresAt: "2020-01-01T00:00:00.000Z" }) });
    expect(expired.status).toBe(201);
    expect((await service.fetch("/ip-rules", from("198.51.100.4"))).status).toBe(200);
    await service.stop();
    running.length = 0;

    await expect(start(`{ ip: { source: databaseIpList({ entity: "IpRule" }) } }`, { files: { "entities/IpRule.ts": "export type IpRule = { cidr: string };\n" } })).rejects.toThrow(
      "databaseIpList: entity IpRule needs the fields cidr and list",
    );
  });
});
