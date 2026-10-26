import { describe, expect, test } from "bun:test";
import { readOutbox, type WriteEvent } from "@quickservice/core";
import { outboxSource } from "../../../core/src/features/realtime/source.ts";
import { startTestService, type TestService } from "../testing/service.ts";

const config = (keys: string) => `import { defineConfig, memoryAdapter } from "@quickservice/core";
export default defineConfig({ database: memoryAdapter(), ${keys}, logger: { info() {}, warn() {}, error() {} } });
`;
const FILES = {
  "quickservice.config.ts": config("events: {}, realtime: {}"),
  "entities/Task.ts": '/** @changes */\nexport type Task = { title: string; status: "open" | "done" };\n',
};
const send = (method: string, body?: unknown) => ({ method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const create = async (service: TestService, title: string, status = "open") => ((await (await service.fetch("/tasks", send("POST", { title, status }))).json()) as { id: string }).id;

/** Reads the raw blocks of an open stream as they arrive. */
function follow(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const blocks: string[] = [];
  let buffer = "";
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buffer += decoder.decode(value);
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        blocks.push(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
      }
    }
  })();
  const field = (block: string, name: string) => block.split("\n").find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
  return {
    blocks,
    titles: () => blocks.map((block) => (JSON.parse(field(block, "data")!) as { record?: { title: string }; reason?: string }).record?.title ?? `reset:${(JSON.parse(field(block, "data")!) as { reason: string }).reason}`),
    ids: () => blocks.map((block) => field(block, "id")),
    async waitFor(count: number) {
      for (let tries = 0; tries < 600 && blocks.length < count; tries++) await Bun.sleep(5);
    },
    async close() {
      await reader.cancel();
      await pump;
    },
  };
}

describe("resume", () => {
  test("a client reconnecting with Last-Event-ID gets the missed events matching its filter, then live ones; the first message has retry: 3000", async () => {
    const service = await startTestService({ files: FILES });
    try {
      const first = follow(await service.fetch("/tasks/changes?where[status][eq]=open"));
      await create(service, "e5");
      await first.waitFor(1);
      expect(first.blocks[0]!.split("\n")).toContain("retry: 3000");
      const seen = first.ids()[0]!;
      await first.close();
      await create(service, "e6", "done");
      await create(service, "e7");
      const again = follow(await service.fetch("/tasks/changes?where[status][eq]=open", { headers: { "last-event-id": seen } }));
      await again.waitFor(1);
      await create(service, "e8");
      await again.waitFor(2);
      await Bun.sleep(20);
      expect(again.titles()).toEqual(["e7", "e8"]);
      expect(again.blocks[0]!.split("\n")).toContain("retry: 3000");
      expect(again.blocks[1]!.split("\n")).not.toContain("retry: 3000");
      await again.close();
      const unknown = follow(await service.fetch("/tasks/changes?lastEventId=nope"));
      await unknown.waitFor(1);
      expect(unknown.blocks[0]).toBe('event: reset\nretry: 3000\ndata: {"reason":"unknown-id"}');
      await unknown.close();
    } finally {
      await service.stop();
    }
  });
});

describe("fan-out through the outbox", () => {
  test("a task created through one instance reaches a stream of another within two poll intervals, exactly once", async () => {
    const service = await startTestService({ files: { ...FILES, "quickservice.config.ts": config('events: { outbox: true }, realtime: { sse: { pollInterval: "1s" } }') } });
    // A second instance reads the same log with its own source.
    const elsewhere: WriteEvent[] = [];
    const other = outboxSource({ pollMs: 1000, retentionMs: 86_400_000, onPollFailed: () => undefined, read: readOutbox });
    const stop = other.subscribe(["Task"], (event) => void elsewhere.push(event));
    try {
      const local = follow(await service.fetch("/tasks/changes"));
      const id = await create(service, "shared");
      const started = Date.now();
      await local.waitFor(1);
      for (let tries = 0; tries < 600 && elsewhere.length === 0; tries++) await Bun.sleep(5);
      expect(Date.now() - started).toBeLessThan(2500);
      await Bun.sleep(1200);
      expect(local.titles()).toEqual(["shared"]);
      expect(elsewhere.map((event) => event.recordId)).toEqual([id]);
      await local.close();
    } finally {
      stop();
      await service.stop();
    }
  });
});
