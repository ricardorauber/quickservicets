import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { testAuth } from "@quickservicets/core/testing";
import { startTestService, type TestService } from "@quickservicets/cli/testing";

const root = join(import.meta.dir, "..");

/** The example's own files, as `startTestService` takes them. */
function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = { "quickservicets.config.ts": readFileSync(join(root, "quickservicets.config.ts"), "utf8") };
  for (const folder of ["endpoints", "entities"]) {
    for (const entry of readdirSync(join(root, folder), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files[relative(root, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), "utf8");
    }
  }
  return files;
}

/** Reads the messages of an open stream as they arrive. */
function follow(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const messages: { event?: string; id?: string; data: { record?: { title: string }; reason?: string } }[] = [];
  let buffer = "";
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buffer += decoder.decode(value);
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (block.startsWith(":")) continue;
        const field = (name: string) => block.split("\n").find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
        messages.push({ ...(field("event") ? { event: field("event") } : {}), ...(field("id") ? { id: field("id") } : {}), data: JSON.parse(field("data")!) });
      }
    }
  })();
  return {
    messages,
    async waitFor(count: number) {
      for (let tries = 0; tries < 400 && messages.length < count; tries++) await Bun.sleep(5);
      return messages;
    },
    async close() {
      await reader.cancel();
      await pump;
    },
  };
}

const create = (service: TestService, title: string, status: "open" | "done") =>
  service.fetch("/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, status }) });

test("the clock stream sends the time as Server-Sent Events", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    const response = await service.fetch("/clock");
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const clock = follow(response);
    const [tick] = await clock.waitFor(1);
    expect(JSON.stringify(tick!.data)).toMatch(/^\{"now":"\d{4}-\d\d-\d\dT[^"]+"\}$/);
    await clock.close();
  } finally {
    await service.stop();
  }
});

test("a filtered change stream gets the open tasks, and a reconnecting client resumes with Last-Event-ID", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    const first = follow(await service.fetch("/tasks/changes?where[status][eq]=open"));
    await create(service, "Write the guide", "open");
    await create(service, "Ship it", "done");
    await create(service, "Review", "open");
    const seen = await first.waitFor(2);
    expect(seen.map((message) => [message.event, message.data.record!.title])).toEqual([
      ["created", "Write the guide"],
      ["created", "Review"],
    ]);
    const lastSeen = seen[0]!.id!;
    await first.close();
    const again = follow(await service.fetch("/tasks/changes?where[status][eq]=open", { headers: { "last-event-id": lastSeen } }));
    await create(service, "Celebrate", "open");
    const resumed = await again.waitFor(2);
    expect(resumed.map((message) => message.data.record!.title)).toEqual(["Review", "Celebrate"]);
    await again.close();
  } finally {
    await service.stop();
  }
});

/** A WebSocket client that keeps the JSON messages it receives. */
async function chat(base: string, room: string, headers: Record<string, string>) {
  const ws = new WebSocket(`${base}/rooms/${room}`, { headers } as never);
  const messages: Record<string, unknown>[] = [];
  ws.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data)) as Record<string, unknown>));
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason })));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("socket failed")));
  });
  return {
    ws,
    messages,
    closed,
    send: (message: unknown) => ws.send(JSON.stringify(message)),
    async wait(count: number) {
      for (let tries = 0; tries < 400 && messages.length < count; tries++) await Bun.sleep(5);
      return messages;
    },
  };
}

const upgrade = { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" };

test("signed-in clients of a room hear each other, get acknowledgments and announcements, and invalid messages are refused", async () => {
  const service = await startTestService({ files: exampleFiles(), auth: testAuth() });
  try {
    expect((await service.fetch("/rooms/lobby", { headers: upgrade })).status).toBe(401);
    const base = (await service.listen()).url.replace("http", "ws");
    const ana = await chat(base, "lobby", { "x-test-user": "ana" });
    const bea = await chat(base, "lobby", { "x-test-user": "bea" });
    ana.send({ type: "say", text: "hello" });
    expect(await bea.wait(1)).toEqual([{ type: "said", text: "hello", from: "ana" }]);
    bea.send({ id: 1, type: "say", text: "hi ana" });
    expect(await ana.wait(1)).toEqual([{ type: "said", text: "hi ana", from: "bea" }]);
    expect(await bea.wait(2)).toEqual([{ type: "said", text: "hello", from: "ana" }, { id: 1, result: { delivered: true } }]);
    ana.send({ type: "say", text: 5 });
    expect((await ana.wait(2))[1]).toMatchObject({ error: { code: "INVALID_MESSAGE", message: "Message does not match the expected shape" } });
    await service.fetch("/rooms/lobby/announce", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "pizza is here" }) });
    const announcement = { type: "said", text: "pizza is here", from: "announcer" };
    expect((await ana.wait(3))[2]).toEqual(announcement);
    expect((await bea.wait(3))[2]).toEqual(announcement);
    await Bun.sleep(30);
    expect(ana.messages.filter((message) => message.from === "ana")).toEqual([]);
  } finally {
    await service.stop();
  }
});

test("a client of another tenant hears nothing of the room, and revoking a session closes its socket with 4401", async () => {
  const files = exampleFiles();
  files["quickservicets.config.ts"] = files["quickservicets.config.ts"]!.replace("realtime: {},", 'realtime: {},\n  tenancy: { source: "config", tenants: { acme: {}, globex: {} } },');
  files["features/admin/index.ts"] = `import { defineFeature } from "@quickservicets/core";
export default defineFeature({
  key: "admin",
  enabledByDefault: true,
  after: ["auth"],
  setup(ctx) {
    const auth = ctx.feature("auth");
    ctx.app.route("POST", "/revoke", async (_repos, req) => (await auth.revoke(await req.json() as { sessionId: string }), { revoked: true }), { auth: false });
  },
});
`;
  const service = await startTestService({ files, auth: testAuth() });
  try {
    const base = (await service.listen()).url.replace("http", "ws");
    const ana = await chat(base, "lobby", { "x-test-user": "ana;tenant=acme;session=s-ana", "x-tenant-id": "acme" });
    const bea = await chat(base, "lobby", { "x-test-user": "bea;tenant=acme", "x-tenant-id": "acme" });
    const carl = await chat(base, "lobby", { "x-test-user": "carl;tenant=globex", "x-tenant-id": "globex" });
    ana.send({ type: "say", text: "acme only" });
    expect(await bea.wait(1)).toEqual([{ type: "said", text: "acme only", from: "ana" }]);
    await service.fetch("/rooms/lobby/announce", { method: "POST", headers: { "content-type": "application/json", "x-tenant-id": "acme" }, body: JSON.stringify({ text: "for acme" }) });
    expect(await bea.wait(2)).toHaveLength(2);
    await Bun.sleep(30);
    expect(carl.messages).toEqual([]);
    await service.fetch("/revoke", { method: "POST", headers: { "content-type": "application/json", "x-tenant-id": "acme" }, body: JSON.stringify({ sessionId: "s-ana" }) });
    expect(await ana.closed).toEqual({ code: 4401, reason: "Session revoked" });
  } finally {
    await service.stop();
  }
});
