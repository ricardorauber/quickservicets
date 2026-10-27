import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { testAuth } from "@quickservicets/core/testing";
import { startTestService, type TestService } from "../testing/service.ts";

const config = (realtime = "realtime: {}", extra = "auth: {},") => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({
  database: memoryAdapter(),
  ${extra}
  ${realtime ? `${realtime.replace(/,$/, "")},` : ""}
  logger: {
    info: (entry: object) => void ((globalThis as any).socketLogs ??= []).push(entry),
    warn: (entry: object) => void ((globalThis as any).socketLogs ??= []).push(entry),
    error: (entry: object) => void ((globalThis as any).socketLogs ??= []).push(entry),
  },
});
`;
const logs = () => ((globalThis as { socketLogs?: Record<string, unknown>[] }).socketLogs ??= []);

const ECHO = `import { defineSocket, HttpError } from "@quickservicets/core";
export default defineSocket({
  open: (ws, ctx) => { if (ctx.user) ws.send(\`hello \${ctx.user.id}\`); },
  message: (ws, data) => {
    if (data === "bad") throw new HttpError(400, "Bad move");
    if (data === "crash") throw new Error("boom");
    ws.send(data);
  },
});
`;
const SECURE = `import { defineSocket } from "@quickservicets/core";
/**
 * @auth
 * @guard
 */
export default defineSocket({ open: (ws, ctx) => ws.send(\`hello \${ctx.user!.id}\`), message: () => {} });
`;
const GUARD = `import { definePreHook, HttpError } from "@quickservicets/core";
export default definePreHook((_repos, req) => { if (req.headers.get("x-blocked")) throw new HttpError(403, "Blocked"); });
`;

const running: TestService[] = [];
beforeEach(() => void (logs().length = 0));
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
});

async function start(files: Record<string, string> = {}, realtime?: string, extra?: string) {
  const service = await startTestService({ files: { "quickservicets.config.ts": config(realtime, extra), "endpoints/echo/ws.ts": ECHO, ...files }, auth: testAuth() });
  running.push(service);
  return service;
}

/** A WebSocket client that records its messages and its close. */
function client(url: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(url, { headers } as never);
  ws.binaryType = "arraybuffer";
  const messages: (string | Uint8Array)[] = [];
  let closed: { code: number; reason: string } | undefined;
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("socket failed")));
  });
  ws.addEventListener("message", (event) => messages.push(typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer)));
  const done = new Promise<{ code: number; reason: string }>((resolve) => ws.addEventListener("close", (event) => resolve((closed = { code: event.code, reason: event.reason }))));
  const until = async (check: () => boolean) => {
    for (let tries = 0; tries < 400 && !check(); tries++) await Bun.sleep(5);
  };
  return {
    ws,
    messages,
    opened,
    done,
    closedWith: () => closed,
    async next(count = messages.length + 1) {
      await until(() => messages.length >= count);
      return messages[count - 1];
    },
  };
}

const upgrade = { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" };
const wsUrl = (service: TestService) => service.listen().then(({ url }) => url.replace("http", "ws"));

describe("ws.ts endpoints", () => {
  test("a ws.ts file echoes text and binary frames", async () => {
    const service = await start();
    const socket = client(`${await wsUrl(service)}/echo`);
    await socket.opened;
    socket.ws.send("hi");
    expect(await socket.next(1)).toBe("hi");
    socket.ws.send(new Uint8Array([1, 2, 3]));
    expect(await socket.next(2)).toEqual(new Uint8Array([1, 2, 3]));
    socket.ws.close();
    await socket.done;
  });

  test("get.ts beside ws.ts fails the build naming both, and ws.ts without realtime fails the build", async () => {
    await expect(start({ "endpoints/echo/get.ts": "export default () => ({});\n" })).rejects.toThrow("endpoints/echo/get.ts and endpoints/echo/ws.ts: a folder has one GET route");
    await expect(start({ "endpoints/echo/sse.ts": 'import { defineSse } from "@quickservicets/core";\nexport default defineSse(() => {});\n' })).rejects.toThrow(
      "endpoints/echo/sse.ts and endpoints/echo/ws.ts: a folder has one GET route",
    );
    await expect(start({}, "")).rejects.toThrow("endpoints/echo/ws.ts needs realtime: {} in quickservicets.config.ts");
    await expect(start({ "endpoints/echo/ws.ts": "export default {};\n" })).rejects.toThrow("endpoints/echo/ws.ts: must default-export defineSocket(...)");
  });
});

describe("the upgrade", () => {
  test("a plain GET answers 426; @auth answers 401 to anonymous upgrades; a pre-hook refusal prevents the upgrade", async () => {
    const service = await start({ "endpoints/secure/ws.ts": SECURE, "hooks/guard.ts": GUARD });
    const plain = await service.fetch("/echo");
    expect(plain.status).toBe(426);
    expect(await plain.json()).toEqual({ error: { code: "UPGRADE_REQUIRED", message: "This route needs a WebSocket connection" } });
    expect((await service.fetch("/secure", { headers: upgrade })).status).toBe(401);
    expect((await service.fetch("/secure", { headers: { ...upgrade, "x-test-user": "u1", "x-blocked": "yes" } })).status).toBe(403);
    const signedIn = client(`${await wsUrl(service)}/secure`, { "x-test-user": "u1" });
    await signedIn.opened;
    expect(await signedIn.next(1)).toBe("hello u1");
    signedIn.ws.close();
  });

  test("a foreign Origin answers 403, while the service's own origin and clients without Origin connect", async () => {
    const service = await start();
    expect(await (await service.fetch("/echo", { headers: { ...upgrade, origin: "https://evil.example" } })).json()).toEqual({ error: { code: "FORBIDDEN", message: "Origin not allowed" } });
    const base = await wsUrl(service);
    const own = client(`${base}/echo`, { origin: base.replace("ws", "http") });
    await own.opened;
    const none = client(`${base}/echo`);
    await none.opened;
    own.ws.close();
    none.ws.close();
  });
});

describe("limits", () => {
  test("maxConnections refuses the next upgrade with 503, a large frame closes with 1009, and too many messages with 1008", async () => {
    const service = await start({}, 'realtime: { websockets: { maxConnections: 2, maxMessageSize: "1MB", messages: "100/10s" } },');
    const base = await wsUrl(service);
    const first = client(`${base}/echo`);
    const second = client(`${base}/echo`);
    await Promise.all([first.opened, second.opened]);
    const refused = await service.fetch("/echo", { headers: upgrade });
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("5");
    first.ws.send("x".repeat(2 * 1024 * 1024));
    await first.done;
    for (let tries = 0; tries < 200 && !logs().some((entry) => entry.status === 101); tries++) await Bun.sleep(5);
    expect(logs().find((entry) => entry.status === 101)).toMatchObject({ closeCode: 1009 });
    for (let index = 0; index < 101; index++) second.ws.send(`m${index}`);
    expect(await second.done).toEqual({ code: 1008, reason: "Too many messages" });
  });
});

describe("errors, shutdown, logs and docs", () => {
  test("an HttpError sends the error object and keeps the socket open; another error closes it with 1011 and is logged", async () => {
    const service = await start();
    const socket = client(`${await wsUrl(service)}/echo`);
    await socket.opened;
    socket.ws.send("bad");
    expect(JSON.parse((await socket.next(1)) as string)).toEqual({ error: { code: "VALIDATION_ERROR", message: "Bad move" } });
    socket.ws.send("still here");
    expect(await socket.next(2)).toBe("still here");
    socket.ws.send("crash");
    expect((await socket.done).code).toBe(1011);
    expect(logs().find((entry) => entry.message === "realtime.socket.failed")).toMatchObject({ route: "/echo", handler: "message", error: { message: "boom" } });
  });

  test("stopping the service closes open sockets with 1001, the closed socket's log entry has its counts, and the docs show 101", async () => {
    const service = await start();
    const socket = client(`${await wsUrl(service)}/echo`);
    await socket.opened;
    socket.ws.send("one");
    await socket.next(1);
    const doc = (await (await service.fetch("/openapi.json")).json()) as { paths: Record<string, { get: Record<string, unknown> }> };
    expect(doc.paths["/echo"]!.get).toMatchObject({ responses: { "101": { description: "Switching to the WebSocket protocol" } }, "x-websocket": true });
    running.splice(running.indexOf(service), 1);
    await service.stop();
    expect(await socket.done).toEqual({ code: 1001, reason: "Server shutting down" });
    expect(logs().find((entry) => entry.route === "/echo" && entry.status === 101)).toMatchObject({ messagesIn: 1, messagesOut: 1, closeCode: 1001 });
  });
});

describe("subprotocols", () => {
  test("the upgrade answers with the first protocol a client offers, as browsers require", async () => {
    const service = await start();
    const ws = new WebSocket(`${await wsUrl(service)}/echo`, ["token.abc", "chat"]);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", reject);
    });
    expect(ws.protocol).toBe("token.abc");
    ws.close();
  });
});
