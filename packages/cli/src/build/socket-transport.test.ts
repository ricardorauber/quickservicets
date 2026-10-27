import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { inProcessTransports, testAuth } from "@quickservicets/core/testing";
import { startTestService, type TestService } from "../testing/service.ts";

const config = (websockets = "") => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({
  database: memoryAdapter(),
  auth: {},
  realtime: { websockets: { ${websockets} } },
  logger: {
    info: (entry: object) => void ((globalThis as any).transportLogs ??= []).push(entry),
    warn: (entry: object) => void ((globalThis as any).transportLogs ??= []).push(entry),
    error: (entry: object) => void ((globalThis as any).transportLogs ??= []).push(entry),
  },
});
`;
const logs = () => ((globalThis as { transportLogs?: Record<string, unknown>[] }).transportLogs ??= []);

const CHAT = `import { defineSocket } from "@quickservicets/core";
export default defineSocket({
  open: (ws) => ws.subscribe("room:1"),
  message: (ws, data) => ws.publish("room:1", data),
});
`;
/** A project feature that connects the service to the test's transport and publishes through the feature API. */
const BRIDGE = `import { defineFeature } from "@quickservicets/core";
export default defineFeature({
  key: "bridge",
  enabledByDefault: true,
  after: ["realtime"],
  setup(ctx) {
    const realtime = ctx.feature("realtime");
    const transport = (globalThis as any).makeTransport();
    if (transport) realtime.setTransport(transport);
    ctx.app.route("POST", "/announce", async (_repos, req) => {
      realtime.sockets().publish("room:1", ((await req.json()) as { text: string }).text);
      return { sent: true };
    });
    ctx.app.route("POST", "/kick", async (_repos, req) => ({ closed: realtime.sockets().disconnect({ user: ((await req.json()) as { user: string }).user }) }));
  },
});
`;
const SECOND = `import { defineFeature } from "@quickservicets/core";
export default defineFeature({
  key: "second",
  enabledByDefault: true,
  after: ["realtime", "bridge"],
  setup: (ctx) => ctx.feature("realtime").setTransport((globalThis as any).makeTransport()),
});
`;

type Global = { makeTransport?: () => unknown };
const global = globalThis as Global;

const running: TestService[] = [];
beforeEach(() => void (logs().length = 0));
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
  delete global.makeTransport;
});

async function start(files: Record<string, string>, websockets = "") {
  const service = await startTestService({ files: { "quickservicets.config.ts": config(websockets), "features/bridge/index.ts": BRIDGE, ...files }, auth: testAuth() });
  running.push(service);
  return service;
}

async function client(url: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(url, { headers } as never);
  const messages: string[] = [];
  ws.addEventListener("message", (event) => messages.push(String(event.data)));
  const done = new Promise<number>((resolve) => ws.addEventListener("close", (event) => resolve(event.code)));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("socket failed")));
  });
  return {
    ws,
    messages,
    done,
    async wait(count: number) {
      for (let tries = 0; tries < 400 && messages.length < count; tries++) await Bun.sleep(5);
      return messages;
    },
  };
}

const socketUrl = async (service: TestService) => `${(await service.listen()).url.replace("http", "ws")}/chat`;

describe("delivery across app instances", () => {
  test("a publish on one instance reaches the room's socket on the other, once on the publishing one", async () => {
    const hub = inProcessTransports();
    global.makeTransport = () => hub.transport();
    const a = await start({ "endpoints/chat/ws.ts": CHAT });
    const b = await start({ "endpoints/chat/ws.ts": CHAT });
    const onA = await client(await socketUrl(a));
    const onB = await client(await socketUrl(b));
    await a.fetch("/announce", { method: "POST", body: JSON.stringify({ text: "from A" }) });
    expect(await onB.wait(1)).toEqual(["from A"]);
    await Bun.sleep(50);
    expect(onA.messages).toEqual(["from A"]);
    onA.ws.send("socket on A");
    expect(await onB.wait(2)).toEqual(["from A", "socket on A"]);
  });

  test("a disconnect on one instance closes the user's socket on the other", async () => {
    const hub = inProcessTransports();
    global.makeTransport = () => hub.transport();
    const a = await start({ "endpoints/chat/ws.ts": CHAT });
    const b = await start({ "endpoints/chat/ws.ts": CHAT });
    const onB = await client(await socketUrl(b), { "x-test-user": "u1" });
    expect(await (await a.fetch("/kick", { method: "POST", body: JSON.stringify({ user: "u1" }) })).json()).toEqual({ closed: 0 });
    expect(await onB.done).toBe(4001);
  });
});

describe("transport selection", () => {
  test("a configured transport without stop fails; a second feature setting one fails naming both", async () => {
    global.makeTransport = () => undefined;
    await expect(start({ "endpoints/chat/ws.ts": CHAT }, "transport: { start() {}, publish() {}, disconnect() {} } as never")).rejects.toThrow("Invalid realtime.websockets.transport");
    const hub = inProcessTransports();
    global.makeTransport = () => hub.transport();
    await expect(start({ "endpoints/chat/ws.ts": CHAT, "features/second/index.ts": SECOND })).rejects.toThrow("realtime.websockets.transport is set by both bridge and second");
  });
});

describe("lifecycle and failures", () => {
  test("without ws.ts the transport never starts, and a failing publish is logged while local sockets still receive", async () => {
    let starts = 0;
    global.makeTransport = () => ({ start: () => void (starts += 1), publish: () => {}, disconnect() {}, stop() {} });
    await start({});
    expect(starts).toBe(0);
    global.makeTransport = () => ({
      start: () => void (starts += 1),
      publish() {
        throw new Error("broker down");
      },
      disconnect() {},
      stop() {},
    });
    const service = await start({ "endpoints/chat/ws.ts": CHAT });
    expect(starts).toBe(1);
    const socket = await client(await socketUrl(service));
    await service.fetch("/announce", { method: "POST", body: JSON.stringify({ text: "still local" }) });
    expect(await socket.wait(1)).toEqual(["still local"]);
    expect(logs().find((entry) => entry.message === "realtime.transport.failed")).toMatchObject({ operation: "publish", error: { message: "broker down" } });
  });
});
