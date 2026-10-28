import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { join } from "node:path";
import { createFeatureLifecycle, createServer, memoryAdapter, middlewareStages, resolveConfig, sqliteAdapter, type DatabaseAdapter, type EntityModel, type LogEntry, type ServiceConfig } from "@quickservicets/core";
import { ipBlockEntity } from "../../../core/src/features/security/ip-blocks.ts";
import { startTestService, type TestService } from "../testing/service.ts";

const CONFIG = (security: string, extra = "") => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({
  database: memoryAdapter(),
  logger: {
    info: (entry: object) => void ((globalThis as any).blockLogs ??= []).push(entry),
    warn: (entry: object) => void ((globalThis as any).blockLogs ??= []).push(entry),
    error: (entry: object) => void ((globalThis as any).blockLogs ??= []).push(entry),
  },
  security: ${security},
  ${extra}
});
`;
type Global = { blockLogs?: Record<string, unknown>[]; blockEvents?: unknown[]; blockedHook?: unknown[] };
const global = globalThis as Global;
const logs = () => (global.blockLogs ??= []);

/** An endpoint that runs one ipBlocks call from its JSON body and answers its result or its error. */
const ADMIN = `import { ipBlocks, type Repositories, type ServiceRequest } from "@quickservicets/core";
export default async (_repos: Repositories, req: ServiceRequest) => {
  const { op, target, options } = (await req.json()) as { op: "block" | "unblock" | "blocked"; target?: string; options?: { for: string; reason?: string } };
  try {
    if (op === "block") return { result: await ipBlocks.block(target!, options as never) };
    if (op === "unblock") return { result: await ipBlocks.unblock(target!) };
    return { result: await ipBlocks.blocked() };
  } catch (error) {
    return { error: (error as Error).message };
  }
};
`;
const FILES = {
  "endpoints/admin/blocks/post.ts": ADMIN,
  "endpoints/ping/get.ts": "export default () => ({ ok: true });\n",
  "endpoints/secret/get.ts": 'import { HttpError } from "@quickservicets/core";\nexport default () => { throw new HttpError(401, "Authentication required"); };\n',
};

/** Sets up the features of a configuration directly, as a worker of `count` would. */
async function setUpLifecycle(security: Record<string, unknown>, options: { env?: Record<string, string>; models?: EntityModel[]; count?: number } = {}) {
  const entries: LogEntry[] = [];
  const logger = { info: (entry: LogEntry) => void entries.push(entry), warn: (entry: LogEntry) => void entries.push(entry), error: (entry: LogEntry) => void entries.push(entry) };
  const config = resolveConfig({ database: memoryAdapter(), logger, security } as ServiceConfig, options.env ?? {});
  const lifecycle = createFeatureLifecycle({ features: config.features, config, models: options.models ?? [], worker: { index: 0, count: options.count ?? 1, runsScheduledWork: true } });
  await lifecycle.setup();
  await lifecycle.stop();
  return entries;
}

const running: TestService[] = [];
afterEach(async () => {
  setSystemTime();
  for (const service of running.splice(0)) await service.stop();
  logs().length = 0;
  delete global.blockEvents;
  delete global.blockedHook;
});

async function start(security: string, options: { extra?: string; files?: Record<string, string>; env?: Record<string, string> } = {}) {
  const service = await startTestService({ files: { "quickservicets.config.ts": CONFIG(security, options.extra), ...FILES, ...options.files }, ...(options.env ? { env: options.env } : {}) });
  running.push(service);
  return service;
}
/** Runs an ipBlocks call through the admin endpoint, from loopback. */
const admin = async (service: TestService, body: Record<string, unknown>) =>
  (await (await service.fetch("/admin/blocks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), peer: "127.0.0.1" })).json()) as { result?: unknown; error?: string };
const from = (peer: string) => ({ peer });
const message = async (response: Response) => ((await response.json()) as { error: { message: string } }).error.message;

describe("blocks from code", () => {
  test("a block refuses its address even when allow-listed, lasts its duration, is listed until then, and bad targets or no for throw", async () => {
    const start0 = new Date("2026-10-28T12:00:00.000Z");
    setSystemTime(start0);
    const service = await start(`{ ip: { allow: ["203.0.113.0/24", "loopback"] } }`);
    expect((await service.fetch("/ping", from("203.0.113.9"))).status).toBe(200);
    const made = await admin(service, { op: "block", target: "203.0.113.9", options: { for: "10m", reason: "abuse" } });
    expect(made.result).toMatchObject({ cidr: "203.0.113.9", reason: "abuse", source: "manual", until: "2026-10-28T12:10:00.000Z" });
    const refused = await service.fetch("/ping", from("203.0.113.9"));
    expect(refused.status).toBe(403);
    expect(await message(refused)).toBe("Address not allowed");
    expect((await service.fetch("/ping", from("203.0.113.10"))).status).toBe(200);
    expect(((await admin(service, { op: "blocked" })).result as unknown[]).length).toBe(1);

    setSystemTime(new Date(start0.getTime() + 10 * 60_000 + 1));
    expect((await service.fetch("/ping", from("203.0.113.9"))).status).toBe(200);
    expect((await admin(service, { op: "blocked" })).result).toEqual([]);

    expect((await admin(service, { op: "block", target: "x", options: { for: "1m" } })).error).toBe('block(): expected an IP address or a CIDR block, got "x"');
    expect((await admin(service, { op: "block", target: "203.0.113.9" })).error).toBe('block() needs for, like "15m"');
  });

  test("unblock serves the address again, a network block covers its addresses, and a path exempted from ip answers a blocked address", async () => {
    const service = await start(`{ ip: {} }`, { extra: "health: {}," });
    await admin(service, { op: "block", target: "203.0.113.9", options: { for: "10m" } });
    expect((await service.fetch("/ping", from("203.0.113.9"))).status).toBe(403);
    expect((await admin(service, { op: "unblock", target: "203.0.113.9" })).result).toBe(true);
    expect((await admin(service, { op: "unblock", target: "203.0.113.9" })).result).toBe(false);
    expect((await service.fetch("/ping", from("203.0.113.9"))).status).toBe(200);
    await admin(service, { op: "block", target: "198.51.100.0/24", options: { for: "10m" } });
    expect((await service.fetch("/ping", from("198.51.100.4"))).status).toBe(403);
    expect((await service.fetch("/health/live", from("198.51.100.4"))).status).toBe(200);
  });
});

describe("the memory store", () => {
  test("several workers log the per-worker warning, and maxEntries evicts the block closest to expiry", async () => {
    const warning = 'security.ip.blocks uses per-worker memory; set security.ip.blocks.store to "database" to share blocks';
    expect((await setUpLifecycle({}, { count: 2 })).some((entry) => entry.message === warning)).toBe(true);
    expect((await setUpLifecycle({}, { count: 1 })).some((entry) => entry.message === warning)).toBe(false);
    const service = await start(`{ ip: { blocks: { maxEntries: 2 } } }`);
    await admin(service, { op: "block", target: "192.0.2.1", options: { for: "5m" } });
    await admin(service, { op: "block", target: "192.0.2.2", options: { for: "1m" } });
    await admin(service, { op: "block", target: "192.0.2.3", options: { for: "9m" } });
    expect(((await admin(service, { op: "blocked" })).result as { cidr: string }[]).map((block) => block.cidr).sort()).toEqual(["192.0.2.1", "192.0.2.3"]);
  });
});

describe("the database store", () => {
  test("the build adds IpBlock without routes, and a build without it fails startup with QS_SECURITY_IP_BLOCKS_STORE=database", async () => {
    const service = await start(`{ ip: { blocks: { store: "database" } } }`);
    const models = (await import(join(service.root, ".generated/models.ts"))).models as EntityModel[];
    expect(models.find((candidate) => candidate.key === "IpBlock")).toMatchObject({ system: true, name: "ip-blocks", indexes: [{ fields: ["until"] }] });
    expect((await service.fetch("/ip-blocks", from("127.0.0.1"))).status).toBe(404);
    await admin(service, { op: "block", target: "203.0.113.9", options: { for: "10m" } });
    expect((await service.fetch("/ping", from("203.0.113.9"))).status).toBe(403);

    await expect(setUpLifecycle({}, { env: { QS_SECURITY_IP_BLOCKS_STORE: "database" } })).rejects.toThrow('security.ip.blocks.store is "database", but the build did not include IpBlock; rebuild and run quickservicets migration add');
  });

  test("two app instances sharing one SQLite database see a block made on one within syncInterval on the other", async () => {
    const model = ipBlockEntity();
    const adapter: DatabaseAdapter = sqliteAdapter({ path: ":memory:" });
    await adapter.connect([model]);
    const client = (adapter as unknown as { client: { run(sql: string): void } }).client;
    client.run('create table "ip_blocks" ("id" text primary key, "created_at" integer not null, "updated_at" integer not null, "cidr" text not null unique, "until" integer not null, "reason" text not null, "source" text not null)');
    const entries: LogEntry[] = [];
    const logger = { info: (entry: LogEntry) => void entries.push(entry), warn: (entry: LogEntry) => void entries.push(entry), error: (entry: LogEntry) => void entries.push(entry) };
    const instance = async () => {
      const config = resolveConfig({ database: adapter, logger, security: { ip: { blocks: { store: "database", syncInterval: "100ms" } } } } as ServiceConfig, {});
      const lifecycle = createFeatureLifecycle({ features: config.features, config, models: [model], worker: { index: 0, count: 1, runsScheduledWork: true } });
      await lifecycle.setup();
      const server = createServer({ routes: [{ method: "GET", path: "/ping", handler: () => ({ ok: true }) }], repos: {}, config: { production: false, logger }, middleware: middlewareStages(lifecycle.middleware), ...lifecycle.server });
      await lifecycle.start({} as never);
      return { lifecycle, call: (peer: string) => server.fetch(new Request("http://localhost/ping"), { peer }) };
    };
    const first = await instance();
    const second = await instance();
    try {
      // The last instance set up is the one ipBlocks reaches; the first learns of the block from the database.
      const { ipBlocks } = await import("@quickservicets/core");
      await ipBlocks.block("203.0.113.9", { for: "10m" });
      expect((await second.call("203.0.113.9")).status).toBe(403);
      for (let tries = 0; tries < 100 && (await first.call("203.0.113.9")).status !== 403; tries++) await Bun.sleep(20);
      expect((await first.call("203.0.113.9")).status).toBe(403);
    } finally {
      await second.lifecycle.stop();
      await first.lifecycle.stop();
      await adapter.disconnect();
    }
  });
});

describe("automatic blocking", () => {
  const AUTO = `{ proxy: { trust: ["loopback"] }, ip: { autoBlock: true } }`;
  const via = (address: string) => ({ peer: "127.0.0.1", headers: { "x-forwarded-for": address } });

  test("20 answers of 401 within a minute block the address for 15 minutes, 19 do not, and 404s never count", async () => {
    setSystemTime(new Date("2026-10-28T12:00:10.000Z"));
    const service = await start(AUTO);
    for (let i = 0; i < 19; i++) expect((await service.fetch("/secret", via("203.0.113.7"))).status).toBe(401);
    expect((await service.fetch("/ping", via("203.0.113.7"))).status).toBe(200);
    expect((await service.fetch("/secret", via("203.0.113.7"))).status).toBe(401);
    await Bun.sleep(10);
    expect((await service.fetch("/ping", via("203.0.113.7"))).status).toBe(403);
    const [block] = (await admin(service, { op: "blocked" })).result as { cidr: string; source: string; reason: string; until: string }[];
    expect(block).toMatchObject({ cidr: "203.0.113.7/32", source: "auto", reason: "auto: 20 responses with 401,403,429 within 1m", until: "2026-10-28T12:15:10.000Z" });

    for (let i = 0; i < 25; i++) expect((await service.fetch("/missing", via("198.51.100.8"))).status).toBe(404);
    expect((await service.fetch("/ping", via("198.51.100.8"))).status).toBe(200);
  });

  test("loopback, allow-listed addresses and exempted paths are never blocked, and the 403s of a block do not extend it", async () => {
    const exempt = `import { defineFeature } from "@quickservicets/core";
export default defineFeature({ key: "quiet", requires: ["security"], setup(ctx) { ctx.feature("security").exempt("/secret", ["ip"]); } });
`;
    const service = await start(`{ proxy: { trust: ["loopback"] }, ip: { autoBlock: true, allow: ["203.0.113.0/24", "198.51.100.0/24", "loopback"] } }`, { files: { "features/quiet/index.ts": exempt }, extra: "quiet: {}," });
    for (let i = 0; i < 50; i++) await service.fetch("/secret", from("127.0.0.1"));
    for (let i = 0; i < 50; i++) await service.fetch("/secret", via("203.0.113.7"));
    expect((await service.fetch("/ping", from("127.0.0.1"))).status).toBe(200);
    expect((await service.fetch("/ping", via("203.0.113.7"))).status).toBe(200);
    expect((await admin(service, { op: "blocked" })).result).toEqual([]);
    await service.stop();
    running.length = 0;

    const counted = await start(`{ proxy: { trust: ["loopback"] }, ip: { autoBlock: { after: 3 } } }`, { files: { "endpoints/locked/get.ts": 'import { HttpError } from "@quickservicets/core";\nexport default () => { throw new HttpError(401, "Authentication required"); };\n' } });
    for (let i = 0; i < 3; i++) await counted.fetch("/locked", via("192.0.2.50"));
    await Bun.sleep(10);
    const [first] = (await admin(counted, { op: "blocked" })).result as { until: string }[];
    for (let i = 0; i < 50; i++) expect((await counted.fetch("/locked", via("192.0.2.50"))).status).toBe(403);
    await Bun.sleep(10);
    const after = (await admin(counted, { op: "blocked" })).result as { until: string }[];
    expect(after).toHaveLength(1);
    expect(after[0]!.until).toBe(first!.until);
  });
});

describe("logs and hooks", () => {
  test("blocking and unblocking log their fields, the hooks receive them, a throwing hook is logged while the block applies, and onBlocked sees reason blocked", async () => {
    const security = `{ ip: {
    onBlock: [(event) => void ((globalThis as any).blockEvents ??= []).push({ kind: "block", ...event }), () => { throw new Error("hook broke"); }],
    onUnblock: [(event) => void ((globalThis as any).blockEvents ??= []).push({ kind: "unblock", ...event })],
    onBlocked: [({ reason }) => void ((globalThis as any).blockedHook ??= []).push(reason)],
  } }`;
    const service = await start(security);
    await admin(service, { op: "block", target: "203.0.113.9", options: { for: "10m", reason: "abuse" } });
    expect((await service.fetch("/ping", from("203.0.113.9"))).status).toBe(403);
    expect(global.blockedHook).toEqual(["blocked"]);
    await admin(service, { op: "unblock", target: "203.0.113.9" });
    const blocked = logs().find((entry) => entry.message === "security.ip.blocked");
    expect(blocked).toMatchObject({ cidr: "203.0.113.9", reason: "abuse", source: "manual" });
    expect(typeof blocked!.until).toBe("string");
    expect(logs().find((entry) => entry.message === "security.ip.unblocked")).toMatchObject({ cidr: "203.0.113.9", reason: "manual", until: blocked!.until });
    expect(logs().some((entry) => entry.message === "feature.hook.failed")).toBe(true);
    expect((global.blockEvents as { kind: string; cidr: string; reason: string }[]).map(({ kind, cidr, reason }) => [kind, cidr, reason])).toEqual([
      ["block", "203.0.113.9", "abuse"],
      ["unblock", "203.0.113.9", "manual"],
    ]);
  });

  test("with ip off, ipBlocks throws", async () => {
    const service = await start(`{ ip: false }`);
    expect((await admin(service, { op: "blocked" })).error).toBe("ipBlocks needs security.ip enabled");
  });
});
