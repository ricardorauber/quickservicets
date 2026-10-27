import { afterEach, describe, expect, test } from "bun:test";
import { startTestService, type TestService } from "../testing/service.ts";

const CONFIG = `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), realtime: {} });
`;
const CHAT = `import { defineSocket, HttpError } from "@quickservicets/core";

type In = { type: "say"; text: string } | { type: "typing" } | { type: "claim"; name: string };
type Out = { type: "said"; text: string };

export default defineSocket<{ in: In; out: Out }>({
  on: {
    say: (ws, m) => {
      ws.send({ type: "said", text: m.text });
      return { ok: true };
    },
    typing: () => {},
    claim: () => {
      throw new HttpError(409, "Taken");
    },
  },
});
`;
const running: TestService[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
});

async function start(files: Record<string, string>) {
  const service = await startTestService({ files: { "quickservicets.config.ts": CONFIG, ...files } });
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

const wsUrl = (service: TestService) => service.listen().then(({ url }) => url.replace("http", "ws"));
const json = (value: string | Uint8Array | undefined) => JSON.parse(value as string) as Record<string, unknown>;

describe("typed messages", () => {
  test("a say message is validated, routed by type and answered", async () => {
    const service = await start({ "endpoints/echo/ws.ts": CHAT });
    const socket = client(`${await wsUrl(service)}/echo`);
    await socket.opened;
    socket.ws.send(JSON.stringify({ type: "say", text: "hi" }));
    expect(json(await socket.next(1))).toEqual({ type: "said", text: "hi" });
  });

  test("invalid JSON and a wrong shape answer INVALID_MESSAGE and keep the socket open", async () => {
    const service = await start({ "endpoints/echo/ws.ts": CHAT });
    const socket = client(`${await wsUrl(service)}/echo`);
    await socket.opened;
    socket.ws.send("not json");
    expect(json(await socket.next(1))).toEqual({ error: { code: "INVALID_MESSAGE", message: "Message is not valid JSON" } });
    socket.ws.send(JSON.stringify({ type: "say", text: 5 }));
    const shape = json(await socket.next(2)) as { error: { code: string; message: string; details: { path: string }[] } };
    expect(shape.error.message).toBe("Message does not match the expected shape");
    expect(shape.error.details[0]!.path).toBe("text");
    socket.ws.send(JSON.stringify({ type: "say", text: "still open" }));
    expect(json(await socket.next(3))).toEqual({ type: "said", text: "still open" });
  });

  test("an unknown type answers UNKNOWN_MESSAGE_TYPE, or reaches the message fallback", async () => {
    const service = await start({ "endpoints/echo/ws.ts": CHAT, "endpoints/fallback/ws.ts": CHAT.replace("  on: {", "  message: (ws, m) => ws.send({ type: \"said\", text: `fallback ${(m as { type: string }).type}` }),\n  on: {") });
    const base = await wsUrl(service);
    const strict = client(`${base}/echo`);
    await strict.opened;
    strict.ws.send(JSON.stringify({ type: "dance" }));
    expect(json(await strict.next(1))).toEqual({ error: { code: "UNKNOWN_MESSAGE_TYPE", message: "Unknown message type dance" } });
    const lenient = client(`${base}/fallback`);
    await lenient.opened;
    lenient.ws.send(JSON.stringify({ type: "dance" }));
    expect(json(await lenient.next(1))).toEqual({ type: "said", text: "fallback dance" });
  });

  test("a message with an id gets the handler's result, or its HttpError, under that id", async () => {
    const service = await start({ "endpoints/echo/ws.ts": CHAT });
    const socket = client(`${await wsUrl(service)}/echo`);
    await socket.opened;
    socket.ws.send(JSON.stringify({ id: 7, type: "say", text: "hi" }));
    expect(json(await socket.next(1))).toEqual({ type: "said", text: "hi" });
    expect(json(await socket.next(2))).toEqual({ id: 7, result: { ok: true } });
    socket.ws.send(JSON.stringify({ id: 7, type: "claim", name: "x" }));
    expect(json(await socket.next(3))).toEqual({ id: 7, error: { code: "CONFLICT", message: "Taken" } });
    socket.ws.send(JSON.stringify({ type: "say", text: "no id" }));
    expect(json(await socket.next(4))).toEqual({ type: "said", text: "no id" });
    await Bun.sleep(30);
    expect(socket.messages).toHaveLength(4);
  });

  test("/openapi.json names the message schemas after the route, and an untyped socket gets raw frames", async () => {
    const service = await start({ "endpoints/echo/ws.ts": CHAT, "endpoints/raw/ws.ts": 'import { defineSocket } from "@quickservicets/core";\nexport default defineSocket({ message: (ws, data) => ws.send(typeof data === "string" ? `text:${data}` : `bytes:${data.length}`) });\n' });
    const doc = (await (await service.fetch("/openapi.json")).json()) as { paths: Record<string, { get: Record<string, unknown> }>; components: { schemas: Record<string, Record<string, unknown>> } };
    expect(doc.paths["/echo"]!.get["x-websocket"]).toEqual({ in: { $ref: "#/components/schemas/EchoSocketIn" }, out: { $ref: "#/components/schemas/EchoSocketOut" } });
    expect(doc.components.schemas.EchoSocketIn!.anyOf as unknown[]).toHaveLength(3);
    expect(doc.components.schemas.EchoSocketOut).toEqual({ type: "object", properties: { type: { type: "string", enum: ["said"] }, text: { type: "string" } }, required: ["type", "text"] });
    expect(doc.paths["/raw"]!.get["x-websocket"]).toBe(true);
    const socket = client(`${await wsUrl(service)}/raw`);
    await socket.opened;
    socket.ws.send("not json");
    expect(await socket.next(1)).toBe("text:not json");
    socket.ws.send(new Uint8Array([1, 2]));
    expect(await socket.next(2)).toBe("bytes:2");
  });
});
