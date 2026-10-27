import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { testAuth } from "@quickservicets/core/testing";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService, type TestService } from "../testing/service.ts";
import { build } from "./build.ts";

const config = (realtime = "{}", extra = "") => `import { defineConfig, HttpError, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), auth: {}, realtime: ${realtime}${extra} });
`;
const ECHO = `import { defineSocket } from "@quickservicets/core";
export default defineSocket({ message: (ws, data) => ws.send(data) });
`;
const tagged = (tag: string) => `import { defineSocket } from "@quickservicets/core";
/** ${tag} */
export default defineSocket({ message: (ws, data) => ws.send(data) });
`;

type Global = { closes?: unknown[] };
const global = globalThis as Global;

const running: TestService[] = [];
beforeEach(() => void (global.closes = []));
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
});

async function start(files: Record<string, string>, env: Record<string, string> = {}) {
  const service = await startTestService({ files, env, auth: testAuth() });
  running.push(service);
  return service;
}

async function client(url: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(url, { headers } as never);
  const messages: string[] = [];
  ws.addEventListener("message", (event) => messages.push(String(event.data)));
  const done = new Promise<{ code: number; reason: string }>((resolve) => ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason })));
  const opened = new Promise<boolean>((resolve) => {
    ws.addEventListener("open", () => resolve(true));
    ws.addEventListener("error", () => resolve(false));
  });
  return {
    ws,
    messages,
    done,
    opened,
    async wait(count: number) {
      for (let tries = 0; tries < 300 && messages.length < count; tries++) await Bun.sleep(5);
      return messages;
    },
  };
}
const wsBase = async (service: TestService) => (await service.listen()).url.replace("http", "ws");
const upgrade = { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" };

describe("variables", () => {
  test("QS_REALTIME_WEBSOCKETS_MESSAGES=2/s closes a socket sending 3 frames in a second", async () => {
    const service = await start({ "quickservicets.config.ts": config(), "endpoints/echo/ws.ts": ECHO }, { QS_REALTIME_WEBSOCKETS_MESSAGES: "2/s" });
    const socket = await client(`${await wsBase(service)}/echo`);
    await socket.opened;
    for (const text of ["a", "b", "c"]) socket.ws.send(text);
    expect(await socket.done).toEqual({ code: 1008, reason: "Too many messages" });
  });
});

describe("the @socket tag", () => {
  test("@socket messages=1/s limits only its route, and origins accepts that origin there only", async () => {
    const service = await start({
      "quickservicets.config.ts": config(),
      "endpoints/echo/ws.ts": ECHO,
      "endpoints/slow/ws.ts": tagged("@socket messages=1/s origins=https://game.example"),
    });
    const base = await wsBase(service);
    const slow = await client(`${base}/slow`);
    const echo = await client(`${base}/echo`);
    await Promise.all([slow.opened, echo.opened]);
    for (const text of ["a", "b"]) {
      slow.ws.send(text);
      echo.ws.send(text);
    }
    expect((await slow.done).code).toBe(1008);
    expect(await echo.wait(2)).toEqual(["a", "b"]);
    expect((await service.fetch("/slow", { headers: { ...upgrade, origin: "https://game.example" } })).status).not.toBe(403);
    expect((await service.fetch("/echo", { headers: { ...upgrade, origin: "https://game.example" } })).status).toBe(403);
  });

  test("@socket maxMessageSize above the global limit fails the build", async () => {
    await expect(start({ "quickservicets.config.ts": config(), "endpoints/echo/ws.ts": tagged("@socket maxMessageSize=2MB") })).rejects.toThrow(
      "endpoints/echo/ws.ts: invalid @socket: maxMessageSize is above realtime.websockets.maxMessageSize",
    );
  });
});

describe("the per-connection message rate", () => {
  test("a function of the tenant gives pro tenants a higher rate", async () => {
    const realtime = `{ websockets: { messages: ({ tenant }) => (tenant?.plan === "pro" ? "50/s" : "5/s") } }`;
    const tenancy = `, tenancy: { source: "config", tenants: { acme: { plan: "pro" }, globex: { plan: "free" } } }`;
    const service = await start({ "quickservicets.config.ts": config(realtime, tenancy), "endpoints/echo/ws.ts": ECHO });
    const base = await wsBase(service);
    const pro = await client(`${base}/echo`, { "x-tenant-id": "acme" });
    const free = await client(`${base}/echo`, { "x-tenant-id": "globex" });
    await Promise.all([pro.opened, free.opened]);
    for (let index = 0; index < 20; index++) {
      pro.ws.send(`m${index}`);
      free.ws.send(`m${index}`);
    }
    expect((await free.done).code).toBe(1008);
    expect(await pro.wait(20)).toHaveLength(20);
    expect(pro.ws.readyState).toBe(WebSocket.OPEN);
  });
});

describe("hooks", () => {
  test("beforeConnect refuses, beforeMessage changes and drops, beforeSubscribe and beforePublish refuse, and onClose sees the code", async () => {
    const realtime = `{
  websockets: {
    beforeConnect: ({ req }) => { if (req.headers.get("x-banned")) throw new HttpError(403, "Banned"); },
    beforeMessage: ({ data }) => (data === "drop" ? null : typeof data === "string" ? data.trim() : data),
    beforeSubscribe: ({ room }) => !room.startsWith("admin:"),
    beforePublish: ({ data }) => (data === "secret" ? null : undefined),
    onClose: ({ code, durationMs }) => void (globalThis as any).closes.push({ code, durationMs }),
  },
}`;
    const ROOMS = `import { defineSocket } from "@quickservicets/core";
export default defineSocket({
  open: (ws) => ws.subscribe("room:1"),
  message: (ws, data) => {
    const text = String(data);
    if (text.startsWith("join ")) {
      try {
        ws.subscribe(text.slice(5));
        ws.send("joined");
      } catch (error) {
        ws.send((error as Error).message);
      }
      return;
    }
    if (text.startsWith("say ")) return ws.publish("room:1", text.slice(4));
    ws.send(\`got:\${text}\`);
  },
});
`;
    const service = await start({ "quickservicets.config.ts": config(realtime), "endpoints/chat/ws.ts": ROOMS });
    expect((await service.fetch("/chat", { headers: { ...upgrade, "x-banned": "yes" } })).status).toBe(403);
    const base = await wsBase(service);
    const one = await client(`${base}/chat`);
    const two = await client(`${base}/chat`);
    await Promise.all([one.opened, two.opened]);
    one.ws.send("  padded  ");
    one.ws.send("drop");
    one.ws.send("join admin:1");
    expect(await one.wait(2)).toEqual(["got:padded", "Not allowed to join admin:1"]);
    one.ws.send("say secret");
    one.ws.send("say hello");
    expect(await two.wait(1)).toEqual(["hello"]);
    one.ws.close(1000);
    await one.done;
    for (let tries = 0; tries < 100 && (global.closes ?? []).length === 0; tries++) await Bun.sleep(5);
    expect(global.closes).toEqual([{ code: 1000, durationMs: expect.any(Number) }]);
  });
});

describe("feature sockets", () => {
  test("a project ws.ts replaces a project feature's at the same path, with an override line", async () => {
    const root = createLinkedProject({
      "quickservicets.config.ts": config("{}", ", game: {}"),
      "features/game/index.ts": 'import { defineFeature } from "@quickservicets/core";\nexport default defineFeature({ key: "game", endpoints: "./endpoints" });\n',
      "features/game/endpoints/game/ws.ts": ECHO,
      "endpoints/game/ws.ts": ECHO.replace("ws.send(data)", 'ws.send("project")'),
    });
    const summary = await build(root, {});
    expect(summary.overrides).toContain("Override: endpoints/game/ws.ts replaces features/game/endpoints/game/ws.ts from game");
  });
});

describe("the reference", () => {
  test("the realtime page lists the transport variable, @socket, the hooks, the sockets API and the close codes", async () => {
    const page = await Bun.file(new URL("../../../../docs/src/content/docs/reference/features/realtime.mdx", import.meta.url)).text();
    for (const text of ["QS_REALTIME_WEBSOCKETS_TRANSPORT", "### `@socket`", "`realtime.websockets.beforeConnect`", "`realtime.websockets.onClose`", "## The sockets API", "| 4401 | Session revoked |", "| 1009 | Message too big |"]) {
      expect(page.includes(text) ? text : `missing ${text}`).toBe(text);
    }
  });
});
