import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import "./index.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { postgresAdapter, type PostgresAdapter } from "./adapters/postgres.ts";
import { sqliteAdapter } from "./adapters/sqlite.ts";
import { defineSocket, sockets } from "./http/socket.ts";
import { postgresTransport, socketChannel } from "./features/realtime/postgres-transport.ts";
import { runSocketTransportContract } from "./testing/socket-transport-contract.ts";
import { startTestApp, type TestApp } from "./tenancy-test-support.ts";
import type { LogEntry } from "./logger.ts";

const url = process.env.TEST_POSTGRES_URL;
const channelOf = (name: string) => `qs_test_${name}_${crypto.randomUUID().slice(0, 8).replace(/-/g, "")}`;

describe("channels and the payload limit", () => {
  test("the channel takes the default schema, and invalid names are refused", async () => {
    expect(socketChannel("quickservicets_sockets", undefined)).toBe("quickservicets_sockets");
    expect(socketChannel("quickservicets_sockets", "tenant-a")).toBe("quickservicets_sockets_tenant_a");
    expect(resolveConfig({ database: memoryAdapter() } as ServiceConfig, { DATABASE_SCHEMA: "tenant-a" }).schema).toBe("tenant-a");
    const adapter = postgresAdapter({ url: "postgres://localhost:1/none" });
    await expect(adapter.listen!("Bad-Channel", () => {})).rejects.toThrow("Invalid channel Bad-Channel");
    await expect(adapter.notify!("bad channel", "x")).rejects.toThrow("Invalid channel bad channel");
  });

  test("an envelope over maxPayload is not sent and is logged once per room and minute", async () => {
    const sent: string[] = [];
    const logs: LogEntry[] = [];
    let now = 0;
    const transport = postgresTransport({ adapter: { listen: async () => async () => {}, notify: async (_channel, payload) => void sent.push(payload) }, channel: "c", maxPayload: 7900, now: () => now });
    await transport.start({ onMessage() {}, onDisconnect() {}, logger: { info: (entry) => void logs.push(entry), warn: (entry) => void logs.push(entry), error: (entry) => void logs.push(entry) } });
    const big = { origin: "o", room: "room:1", data: "x".repeat(10 * 1024) };
    await transport.publish(big);
    now += 30_000;
    await transport.publish(big);
    await transport.publish({ origin: "o", room: "room:1", data: "small" });
    expect(sent).toHaveLength(1);
    expect(logs.filter((entry) => entry.message === "realtime.transport.too-large")).toEqual([expect.objectContaining({ room: "room:1", maxPayload: 7900 })]);
    now += 60_000;
    await transport.publish(big);
    expect(logs.filter((entry) => entry.message === "realtime.transport.too-large")).toHaveLength(2);
    await transport.stop();
  });

  test("the postgres transport needs the PostgreSQL adapter", async () => {
    await expect(startTestApp({ config: { realtime: { websockets: { transport: "postgres" } } }, database: sqliteAdapter({ path: ":memory:" }), endpoints: [{ path: "/chat", kind: "websocket", handler: defineSocket({ message() {} }) }] })).rejects.toThrow(
      'realtime.websockets.transport "postgres" needs the PostgreSQL adapter',
    );
  });
});

if (!url) {
  test.skip("postgres socket transport (set TEST_POSTGRES_URL to run)", () => {});
} else {
  const adapter = postgresAdapter({ url }) as PostgresAdapter;
  const admin = new SQL(url);
  /** Ends the listening backends of a channel, as a network failure would. */
  const terminate = (channel: string) => admin`select pg_terminate_backend(pid) from pg_stat_activity where query ilike ${`%listen%${channel}%`} and pid <> pg_backend_pid()`;
  beforeAll(() => adapter.connect([]));
  afterAll(async () => {
    await adapter.disconnect();
    await admin.close();
  });

  describe("the adapter", () => {
    test("listen receives what notify sends, and unsubscribing stops it", async () => {
      const channel = channelOf("adapter");
      const received: string[] = [];
      const stop = await adapter.listen!(channel, (payload) => void received.push(payload));
      await adapter.notify!(channel, "hello");
      for (let tries = 0; tries < 100 && received.length === 0; tries++) await Bun.sleep(10);
      expect(received).toEqual(["hello"]);
      await stop();
      await adapter.notify!(channel, "gone");
      await Bun.sleep(100);
      expect(received).toEqual(["hello"]);
    });

    test("an invalid payload is logged and ignored", async () => {
      const channel = channelOf("invalid");
      const logs: LogEntry[] = [];
      const transport = postgresTransport({ adapter, channel, maxPayload: 7900 });
      const messages: unknown[] = [];
      await transport.start({ onMessage: (envelope) => void messages.push(envelope), onDisconnect() {}, logger: { info: (e) => void logs.push(e), warn: (e) => void logs.push(e), error: (e) => void logs.push(e) } });
      await admin`select pg_notify(${channel}, 'not json')`;
      await transport.publish({ origin: "o", room: "r", data: "after" });
      for (let tries = 0; tries < 100 && messages.length === 0; tries++) await Bun.sleep(10);
      expect(logs.find((entry) => entry.message === "realtime.transport.invalid")).toBeDefined();
      expect(messages).toHaveLength(1);
      await transport.stop();
    });
  });

  const contractChannel = channelOf("contract");
  runSocketTransportContract(() => postgresTransport({ adapter, channel: contractChannel, maxPayload: 7900 }), { name: "postgres", drop: () => void terminate(contractChannel) });

  describe("two app instances on one database", () => {
    const running: TestApp[] = [];
    const servers: { stop(close?: boolean): unknown }[] = [];
    afterEach(async () => {
      for (const server of servers.splice(0)) await server.stop(true);
      for (const app of running.splice(0)) await app.stop();
    });

    const chat = defineSocket({ open: (ws) => ws.subscribe("room:1"), message: () => {} });

    async function instance(channel: string, extra: Record<string, unknown> = {}) {
      const app = await startTestApp({
        config: { realtime: { websockets: { transport: "postgres", postgres: { channel } } }, ...extra },
        database: postgresAdapter({ url: url! }),
        endpoints: [
          { path: "/chat", kind: "websocket", handler: chat },
          { method: "POST", path: "/announce", handler: async (_repos, req) => (sockets.publish("room:1", ((await req.json()) as { text: string }).text), { sent: true }) },
        ],
      });
      running.push(app);
      const server = app.app.server.listen(0);
      servers.push(server);
      return { app, url: `ws://localhost:${server.port}/chat`, http: `http://localhost:${server.port}` };
    }

    async function client(address: string) {
      const ws = new WebSocket(address);
      const messages: { text: string; at: number }[] = [];
      ws.addEventListener("message", (event) => messages.push({ text: String(event.data), at: performance.now() }));
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error("socket failed")));
      });
      return { ws, messages };
    }

    test("a publish on A reaches B's socket within 100 ms, and A's socket once", async () => {
      const channel = channelOf("apps");
      const a = await instance(channel);
      const b = await instance(channel);
      const onA = await client(a.url);
      const onB = await client(b.url);
      await Bun.sleep(100);
      const sentAt = performance.now();
      // The global sockets API reaches the last started instance, B; its publish must cross to A.
      await fetch(`${b.http}/announce`, { method: "POST", body: JSON.stringify({ text: "hello" }) });
      for (let tries = 0; tries < 100 && onA.messages.length === 0; tries++) await Bun.sleep(5);
      expect(onA.messages.map((message) => message.text)).toEqual(["hello"]);
      expect(onA.messages[0]!.at - sentAt).toBeLessThan(100);
      await Bun.sleep(100);
      expect(onB.messages.map((message) => message.text)).toEqual(["hello"]);
      expect(onA.messages).toHaveLength(1);
    });

    test("terminating the listening backend reconnects, logs the downtime, and readiness reports the transport while it is down", async () => {
      const channel = channelOf("health");
      const { app, http } = await instance(channel, { health: {} });
      await client(`${http.replace("http", "ws")}/chat`);
      await terminate(channel);
      await Bun.sleep(20);
      const ready = (await (await fetch(`${http}/health/ready`)).json()) as { checks: Record<string, { status: string }> };
      expect(ready.checks["realtime.transport"]?.status).toBe("fail");
      for (let tries = 0; tries < 300 && !app.logs.some((entry) => entry.message === "realtime.transport.reconnected"); tries++) await Bun.sleep(10);
      expect(app.logs.find((entry) => entry.message === "realtime.transport.reconnected")).toMatchObject({ channel });
    });
  });
}
