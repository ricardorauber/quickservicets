import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mockHttp, testAuth } from "@quickservicets/core/testing";
import { startTestService, type TestService } from "../testing/service.ts";
import { recordingMeter } from "../../../core/src/tracing-test-support.ts";

type Meter = ReturnType<typeof recordingMeter>;
const holder = globalThis as { testMeter?: Meter; testMeterOptions?: object };

const CONFIG = (extra = "") => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({
  database: memoryAdapter(),
  logger: { info() {}, warn() {}, error() {} },
  ${extra}
});
`;
const METER_FEATURE = `import { defineFeature, setMeter } from "@quickservicets/core";
export default defineFeature({
  key: "meter",
  enabledByDefault: true,
  setup() {
    const meter = (globalThis as any).testMeter;
    if (meter) setMeter(meter, (globalThis as any).testMeterOptions);
  },
});
`;
const FILES = {
  "features/meter/index.ts": METER_FEATURE,
  "entities/User.ts": "export type User = { name: string };\n",
  "endpoints/bill/get.ts": `import type { Repositories, ServiceRequest } from "@quickservicets/core";
export default (_repos: Repositories, req: ServiceRequest) => req.http.service("billing").get("/x").send();
`,
  "endpoints/me/get.ts": `import type { Repositories, ServiceRequest } from "@quickservicets/core";
export default (_repos: Repositories, req: ServiceRequest) => ({ user: req.user?.id ?? null });
`,
};
const SERVICES = `http: { services: { billing: { url: "https://billing.test", retry: { backoff: "1ms" } } } },`;

const running: TestService[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
  delete holder.testMeter;
  delete holder.testMeterOptions;
});

async function start(extra = "", files: Record<string, string> = {}, options: { metered?: boolean; meterOptions?: object; env?: Record<string, string>; auth?: boolean } = {}) {
  const meter = options.metered === false ? undefined : recordingMeter();
  if (meter) holder.testMeter = meter;
  if (options.meterOptions) holder.testMeterOptions = options.meterOptions;
  const service = await startTestService({
    files: { "quickservicets.config.ts": CONFIG(extra), ...FILES, ...files },
    ...(options.env ? { env: options.env } : {}),
    ...(options.auth ? { auth: testAuth() } : {}),
  });
  running.push(service);
  return { service, meter: meter! };
}

const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("server and client instruments", () => {
  test("one request duration per request with its route and status, active requests back to 0, and a duration per client attempt", async () => {
    const { service, meter } = await start(SERVICES);
    const created = (await (await service.fetch("/users", post({ name: "ann" }))).json()) as { id: string };
    meter.named("http.server.request.duration")!.values.length = 0;
    await service.fetch(`/users/${created.id}`);
    const durations = meter.named("http.server.request.duration")!.values;
    expect(durations).toHaveLength(1);
    expect(durations[0]!.attributes).toEqual({ "http.request.method": "GET", "url.scheme": "http", "http.route": "/users/[id]", "http.response.status_code": 200 });
    expect(meter.named("http.server.request.duration")!.kind).toBe("histogram");
    const active = meter.named("http.server.active_requests")!;
    expect(active.kind).toBe("upDownCounter");
    expect(active.values.reduce((sum, entry) => sum + entry.value, 0)).toBe(0);

    const mock = mockHttp();
    try {
      mock.service("billing").on("GET", "/x").reply(200, { ok: true });
      mock.service("billing").on("GET", "/x").reply(503).once();
      await service.fetch("/bill");
      const client = meter.named("http.client.request.duration")!.values;
      expect(client).toHaveLength(2);
      expect(client.map((entry) => entry.attributes["http.response.status_code"])).toEqual([503, 200]);
      for (const entry of client) expect(entry.attributes).toMatchObject({ "http.request.method": "GET", "server.address": "billing.test", "quickservicets.http.service": "billing" });
    } finally {
      mock.restore();
    }
    const database = meter.named("db.client.operation.duration")!.values;
    expect(database.some((entry) => entry.attributes["db.operation.name"] === "findById" && entry.attributes["db.collection.name"] === "users" && entry.attributes["db.system.name"] === "memory")).toBe(true);
  });
});

describe("database and queue instruments", () => {
  test("a list records findMany, and the depth gauge reports the waiting messages of each queue", async () => {
    const { service, meter } = await start(`queues: {},`, {
      "queues/send-email.ts": 'import { queue } from "@quickservicets/core";\nexport default queue(async () => {});\n',
      "endpoints/send/post.ts": 'import type { ServiceRequest } from "@quickservicets/core";\nexport default (_repos: unknown, req: ServiceRequest) => req.queue.add("send-email", {});\n',
    }, { env: { QS_QUEUES_CONSUME: "false" } });
    await service.fetch("/users");
    expect(meter.named("db.client.operation.duration")!.values.some((entry) => entry.attributes["db.operation.name"] === "findMany")).toBe(true);
    for (let i = 0; i < 3; i++) await service.fetch("/send", { method: "POST" });
    expect(await meter.collect("quickservicets.queue.depth")).toContainEqual({ value: 3, attributes: { "messaging.destination.name": "send-email" } });
  });
});

describe("realtime and security instruments", () => {
  test("two open sockets read 2 on the connections gauge, and 429 answers count by route", async () => {
    const { service, meter } = await start(`realtime: {},`, {
      "endpoints/echo/ws.ts": 'import { defineSocket } from "@quickservicets/core";\nexport default defineSocket({ message: (ws, data) => ws.send(data) });\n',
    });
    const { url } = await service.listen();
    const open = async () => {
      const ws = new WebSocket(`${url.replace("http", "ws")}/echo`);
      await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
      return ws;
    };
    const sockets = [await open(), await open()];
    expect(await meter.collect("quickservicets.realtime.connections")).toContainEqual({ value: 2, attributes: { "quickservicets.realtime.kind": "websocket" } });
    for (const ws of sockets) ws.close();
    await service.stop();
    running.length = 0;

    const limited = await start(`security: { rateLimit: { limit: "1/min" } },`);
    await limited.service.fetch("/users", { peer: "203.0.113.7" });
    expect((await limited.service.fetch("/users", { peer: "203.0.113.7" })).status).toBe(429);
    expect(limited.meter.named("quickservicets.security.rate_limited")!.values).toEqual([{ value: 1, attributes: { "http.route": "/users" } }]);
  });
});

describe("attribute bounds and the disabled path", () => {
  test("unmatched routes, no user ids, the tenant only when asked for", async () => {
    const { service, meter } = await start(`auth: {},`, {}, { auth: true });
    await service.fetch("/nowhere");
    await service.fetch("/me", { headers: { "x-test-user": "u1" } });
    const values = meter.named("http.server.request.duration")!.values;
    expect(values[0]!.attributes["http.route"]).toBe("unmatched");
    expect(values[0]!.attributes["http.response.status_code"]).toBe(404);
    expect(values[1]!.attributes["http.response.status_code"]).toBe(200);
    expect(JSON.stringify(meter.instruments.map((instrument) => instrument.values))).not.toContain("u1");
    await service.stop();
    running.length = 0;

    const tenants = await start(`tenancy: { source: "config", tenants: { acme: {} } },`, {}, { meterOptions: { tenantAttribute: true } });
    await tenants.service.fetch("/users", { headers: { "x-tenant-id": "acme" } });
    expect(tenants.meter.named("http.server.request.duration")!.values.at(-1)!.attributes["quickservicets.tenant"]).toBe("acme");
  });

  test("without a meter no instrument is created after 100 requests", async () => {
    const metering = await import("../../../core/src/metering.ts");
    const created = spyOn(metering, "coreInstruments");
    try {
      const { service } = await start("", {}, { metered: false });
      for (let i = 0; i < 100; i++) await service.fetch("/users");
      expect(metering.metricsEnabled()).toBe(false);
      expect(created).not.toHaveBeenCalled();
    } finally {
      created.mockRestore();
    }
  });
});
