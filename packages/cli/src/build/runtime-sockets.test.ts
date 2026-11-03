import { afterEach, describe, expect, test } from "bun:test";
import { registerProjectFeatures } from "@quickservicets/core";
import { testAuth } from "@quickservicets/core/testing";
import { startTestService, type TestService } from "../testing/service.ts";

afterEach(() => registerProjectFeatures([]));

const running: TestService[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
});

/** A feature adding `/live/[room]` at runtime: sockets join their room and publish what they send to it. */
const LIVE = (options = "{}", key = "live", path = "/live/[room]") => `import { defineFeature, defineSocket, HttpError, type OpenApiDoc } from "@quickservicets/core";
export default defineFeature({
  key: "${key}",
  requires: ["realtime"],
  setup(ctx) {
    ctx.feature("realtime").socket("${path}", defineSocket({
      open: (ws) => {
        ws.subscribe(ws.params.room!);
        ws.send("ready");
      },
      message: (ws, data) => ws.publish(ws.params.room!, typeof data === "string" ? data : JSON.stringify(data)),
    }), ${options});
    (globalThis as unknown as { liveApi: unknown }).liveApi = ctx.feature("realtime");
  },
  openapi(doc: OpenApiDoc) {
    doc.paths["/live/{room}"] = { get: { summary: "Live room", "x-websocket": true, responses: { "101": { description: "Switching to the WebSocket protocol" } } } };
    return doc;
  },
});
`;
const config = (keys: string) => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), realtime: {}, logger: { info: (entry) => globalThis.socketLogs?.push(entry), warn() {}, error() {} }, ${keys} });
`;

async function start(keys = "live: {}", files: Record<string, string> = { "features/live/index.ts": LIVE() }, auth = false) {
  (globalThis as unknown as { socketLogs: unknown[] }).socketLogs = [];
  const service = await startTestService({ files: { "quickservicets.config.ts": config(keys), ...files }, ...(auth ? { auth: testAuth() } : {}) });
  running.push(service);
  return service;
}

async function client(url: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(url, { headers } as never);
  const messages: string[] = [];
  ws.addEventListener("message", (event) => messages.push(String(event.data)));
  const closed = new Promise<{ code: number }>((resolve) => ws.addEventListener("close", (event) => resolve({ code: event.code })));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("socket failed")));
  });
  const next = async (count: number) => {
    for (let tries = 0; tries < 400 && messages.length < count; tries++) await Bun.sleep(5);
    return messages[count - 1];
  };
  await next(1);
  return { ws, messages, closed, next };
}

describe("runtime socket routes", () => {
  test("two clients of /live/a exchange messages; a plain GET answers 426", async () => {
    const service = await start();
    const base = (await service.listen()).url.replace("http", "ws");
    const first = await client(`${base}/live/a`);
    const second = await client(`${base}/live/a`);
    first.ws.send("hello");
    expect(await second.next(2)).toBe("hello");
    expect((await service.fetch("/live/a")).status).toBe(426);
  });

  test("with auth.required an anonymous upgrade answers 401; auth: false keeps the route public", async () => {
    const strict = await start("auth: { required: true }, live: {}", { "features/live/index.ts": LIVE() }, true);
    expect((await strict.fetch("/live/a", { headers: { upgrade: "websocket", connection: "upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } })).status).toBe(401);
    const open = await start("auth: { required: true }, live: {}", { "features/live/index.ts": LIVE("{ auth: false }") }, true);
    const base = (await open.listen()).url.replace("http", "ws");
    expect((await client(`${base}/live/a`)).messages[0]).toBe("ready");
  });

  test("messages: 2/s closes a socket sending five frames in a second with 1008; a maxMessageSize above the global one throws", async () => {
    const service = await start("live: {}", { "features/live/index.ts": LIVE('{ messages: "2/s" }') });
    const base = (await service.listen()).url.replace("http", "ws");
    const socket = await client(`${base}/live/a`);
    for (let index = 0; index < 5; index++) socket.ws.send(`m${index}`);
    expect((await socket.closed).code).toBe(1008);
    await expect(start("live: {}", { "features/live/index.ts": LIVE('{ maxMessageSize: "2MB" }') })).rejects.toThrow("maxMessageSize of /live/[room] is above realtime.websockets.maxMessageSize");
  });

  test("validate refuses frames without a type with INVALID_MESSAGE and keeps the socket open", async () => {
    const options = `{ validate: (value) => { if (typeof value !== "object" || value === null || !("type" in value)) throw new HttpError(400, "A type is required"); return value; } }`;
    const service = await start("live: {}", { "features/live/index.ts": LIVE(options) });
    const base = (await service.listen()).url.replace("http", "ws");
    const socket = await client(`${base}/live/a`);
    const peer = await client(`${base}/live/a`);
    socket.ws.send(JSON.stringify({ text: "no type" }));
    expect(JSON.parse((await socket.next(2))!)).toMatchObject({ error: { code: "INVALID_MESSAGE" } });
    socket.ws.send(JSON.stringify({ type: "say" }));
    expect(await peer.next(2)).toBe(JSON.stringify({ type: "say" }));
    expect(socket.ws.readyState).toBe(WebSocket.OPEN);
  });

  test("a ws.ts file at the path wins with an info line; two features on one path fail; socket() after setup throws", async () => {
    const file = 'import { defineSocket } from "@quickservicets/core";\nexport default defineSocket({ open: (ws) => ws.send("from file"), message: () => {} });\n';
    const service = await start("live: {}", { "features/live/index.ts": LIVE(), "endpoints/live/[room]/ws.ts": file });
    const base = (await service.listen()).url.replace("http", "ws");
    expect((await client(`${base}/live/a`)).messages[0]).toBe("from file");
    expect(JSON.stringify((globalThis as unknown as { socketLogs: unknown[] }).socketLogs)).toContain("replaces the WebSocket route of live");
    await expect(start("live: {}, other: {}", { "features/live/index.ts": LIVE(), "features/other/index.ts": LIVE("{}", "other") })).rejects.toThrow("WebSocket route /live/[room] of other conflicts with live");
    const api = (globalThis as unknown as { liveApi: { socket(path: string, definition: unknown): void } }).liveApi;
    expect(() => api.socket("/late", {})).toThrow("socket() must be called during setup");
    await expect(start("live: {}, realtime: { websockets: false }")).rejects.toThrow("live adds a WebSocket route but realtime.websockets is disabled");
  });

  test("/openapi.json lists the route with x-websocket; without sockets no WebSocket handler is passed to Bun", async () => {
    const service = await start();
    const doc = (await (await service.fetch("/openapi.json")).json()) as { paths: Record<string, { get: Record<string, unknown> }> };
    expect(doc.paths["/live/{room}"]!.get["x-websocket"]).toBe(true);
    const plain = await start("", {});
    const base = (await plain.listen()).url.replace("http", "ws");
    await expect(client(`${base}/live/a`)).rejects.toThrow("socket failed");
  });
});
