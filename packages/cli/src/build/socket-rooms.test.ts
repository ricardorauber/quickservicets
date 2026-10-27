import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { testAuth } from "@quickservicets/core/testing";
import { startTestService, type TestService } from "../testing/service.ts";

const config = (extra = "") => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), auth: {}, realtime: {}${extra} });
`;

/** A socket driven by JSON commands: join, leave, say (publish to a room), rooms and count. */
const ROOMS = `import { defineSocket, sockets } from "@quickservicets/core";
type Command = { cmd: string; room?: string; text?: string };
export default defineSocket({
  open: (ws) => ws.send(JSON.stringify({ id: ws.id })),
  message: (ws, data) => {
    const command = JSON.parse(String(data)) as Command;
    try {
      if (command.cmd === "join") ws.subscribe(command.room!);
      if (command.cmd === "join-many") for (let index = 0; index < 101; index++) ws.subscribe(\`room:\${index}\`);
      if (command.cmd === "leave") ws.unsubscribe(command.room!);
      if (command.cmd === "say") ws.publish(command.room!, command.text!);
      ws.send(JSON.stringify({ ok: command.cmd, rooms: ws.rooms, count: command.room ? sockets.count(command.room) : undefined }));
    } catch (error) {
      ws.send(JSON.stringify({ error: (error as Error).message }));
    }
  },
});
`;
const ANNOUNCE = `import { sockets, type Endpoint } from "@quickservicets/core";
const handler: Endpoint<{ room: string; text: string; tenant?: string; except?: string }> = async (_repos, req) => {
  const { room, text, tenant, except } = await req.json();
  sockets.publish(room, text, { ...(tenant ? { tenant } : {}), ...(except ? { except } : {}) });
  return { sent: true };
};
export default handler;
`;
const KICK = `import { sockets, type Endpoint } from "@quickservicets/core";
const handler: Endpoint<{ user: string }> = async (_repos, req) => ({ closed: sockets.disconnect({ user: (await req.json()).user }) });
export default handler;
`;
/** A project feature that revokes sessions and counts sockets through the feature APIs. */
const ADMIN = `import { defineFeature } from "@quickservicets/core";
export default defineFeature({
  key: "admin",
  enabledByDefault: true,
  after: ["auth", "realtime"],
  setup(ctx) {
    const auth = ctx.feature("auth");
    const realtime = ctx.feature("realtime");
    ctx.app.route("POST", "/revoke", async (_repos, req) => {
      await auth.revoke({ sessionId: ((await req.json()) as { sessionId: string }).sessionId });
      return { revoked: true };
    });
    ctx.app.route("GET", "/count/[room]", (_repos, req) => ({ count: realtime.sockets().count(req.params.room!) }));
  },
});
`;

const running: TestService[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
});

async function start(extra = "", files: Record<string, string> = {}) {
  const service = await startTestService({
    files: { "quickservicets.config.ts": config(extra), "endpoints/chat/ws.ts": ROOMS, "endpoints/announce/post.ts": ANNOUNCE, "endpoints/kick/post.ts": KICK, "features/admin/index.ts": ADMIN, ...files },
    auth: testAuth(),
  });
  running.push(service);
  return service;
}

/** A client that records messages; the first is the socket's id. */
async function client(url: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(url, { headers } as never);
  const messages: string[] = [];
  ws.addEventListener("message", (event) => messages.push(String(event.data)));
  const done = new Promise<{ code: number; reason: string }>((resolve) => ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason })));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("socket failed")));
  });
  const next = async (count: number) => {
    for (let tries = 0; tries < 400 && messages.length < count; tries++) await Bun.sleep(5);
    return messages[count - 1];
  };
  const id = (JSON.parse((await next(1))!) as { id: string }).id;
  return {
    ws,
    id,
    messages,
    done,
    next,
    async command(command: Record<string, unknown>) {
      const count = messages.length + 1;
      ws.send(JSON.stringify(command));
      return JSON.parse((await next(count))!) as Record<string, unknown>;
    },
  };
}

const post = (service: TestService, path: string, body: unknown, headers: Record<string, string> = {}) =>
  service.fetch(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("rooms", () => {
  test("a socket's publish reaches the room's other sockets, and sockets.publish reaches all of them", async () => {
    const service = await start();
    const url = `${(await service.listen()).url.replace("http", "ws")}/chat`;
    const [first, second, third] = [await client(url), await client(url), await client(url)];
    expect(await first.command({ cmd: "join", room: "room:1" })).toMatchObject({ rooms: ["room:1"], count: 1 });
    expect(await second.command({ cmd: "join", room: "room:1" })).toMatchObject({ count: 2 });
    first.ws.send(JSON.stringify({ cmd: "say", room: "room:1", text: "hi" }));
    expect(await second.next(3)).toBe("hi");
    expect(await first.next(3)).toBe(JSON.stringify({ ok: "say", rooms: ["room:1"], count: 2 }));
    await post(service, "/announce", { room: "room:1", text: "all" });
    expect(await first.next(4)).toBe("all");
    expect(await second.next(4)).toBe("all");
    await post(service, "/announce", { room: "room:1", text: "not you", except: first.id });
    expect(await second.next(5)).toBe("not you");
    await Bun.sleep(30);
    expect(first.messages).toHaveLength(4);
    expect(third.messages).toHaveLength(1);
  });

  test("invalid names and too many rooms throw", async () => {
    const service = await start();
    const socket = await client(`${(await service.listen()).url.replace("http", "ws")}/chat`);
    expect(await socket.command({ cmd: "join", room: "bad room!" })).toEqual({ error: "Invalid room name bad room!" });
    expect(await socket.command({ cmd: "join-many" })).toEqual({ error: "Socket joined too many rooms (max 100)" });
  });

  test("counts follow subscriptions, and a project feature reaches them through ctx.feature(realtime).sockets()", async () => {
    const service = await start();
    const url = `${(await service.listen()).url.replace("http", "ws")}/chat`;
    const [first, second] = [await client(url), await client(url)];
    await first.command({ cmd: "join", room: "room:1" });
    await second.command({ cmd: "join", room: "room:1" });
    expect(await (await service.fetch("/count/room:1")).json()).toEqual({ count: 2 });
    expect(await second.command({ cmd: "leave", room: "room:1" })).toMatchObject({ rooms: [], count: 1 });
    expect(await (await service.fetch("/count/room:1")).json()).toEqual({ count: 1 });
  });
});

describe("tenants", () => {
  test("rooms are kept apart per tenant, and root-scope code publishes to one tenant's room", async () => {
    const service = await start(", tenancy: { source: \"config\", tenants: { acme: {}, globex: {} } }", {
      "endpoints/job/post.ts": ANNOUNCE.replace("const handler", "/** @tenancy off */\nconst handler"),
    });
    const url = `${(await service.listen()).url.replace("http", "ws")}/chat`;
    const acme = await client(url, { "x-tenant-id": "acme" });
    const globex = await client(url, { "x-tenant-id": "globex" });
    await acme.command({ cmd: "join", room: "room:1" });
    await globex.command({ cmd: "join", room: "room:1" });
    await post(service, "/announce", { room: "room:1", text: "for acme" }, { "x-tenant-id": "acme" });
    expect(await acme.next(3)).toBe("for acme");
    await post(service, "/job", { room: "room:1", text: "job for acme", tenant: "acme" });
    expect(await acme.next(4)).toBe("job for acme");
    await post(service, "/announce", { room: "room:1", text: "for globex" }, { "x-tenant-id": "globex" });
    expect(await globex.next(3)).toBe("for globex");
    await Bun.sleep(30);
    expect(acme.messages).toHaveLength(4);
    expect(globex.messages).toHaveLength(3);
  });
});

describe("disconnects", () => {
  test("sockets.disconnect closes a user's sockets with 4001, and revoking a session closes its sockets with 4401", async () => {
    const service = await start();
    const url = `${(await service.listen()).url.replace("http", "ws")}/chat`;
    const [one, two] = [await client(url, { "x-test-user": "u1" }), await client(url, { "x-test-user": "u1" })];
    const other = await client(url, { "x-test-user": "u2;session=s1" });
    expect(await (await post(service, "/kick", { user: "u1" })).json()).toEqual({ closed: 2 });
    expect(await one.done).toEqual({ code: 4001, reason: "Disconnected" });
    expect((await two.done).code).toBe(4001);
    await post(service, "/revoke", { sessionId: "s1" });
    expect(await other.done).toEqual({ code: 4401, reason: "Session revoked" });
  });
});

describe("cost", () => {
  test("a publish to an empty room is one Bun publish call", async () => {
    const service = await start();
    const url = `${(await service.listen()).url.replace("http", "ws")}/chat`;
    const socket = await client(url);
    const probe = Bun.serve({ port: 0, fetch: () => new Response() });
    const publish = spyOn(Object.getPrototypeOf(probe) as { publish: (...args: unknown[]) => number }, "publish");
    try {
      await post(service, "/announce", { room: "empty", text: "nobody" });
      expect(publish).toHaveBeenCalledTimes(1);
    } finally {
      publish.mockRestore();
      await probe.stop(true);
      socket.ws.close();
    }
  });
});
