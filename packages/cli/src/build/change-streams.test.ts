import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { events } from "@quickservicets/core";
import { startTestService, type TestService } from "../testing/service.ts";

const config = (keys = "events: {}, realtime: {}") => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), ${keys}, logger: { info() {}, warn() {}, error() {} } });
`;
const FILES = {
  "quickservicets.config.ts": config(),
  "entities/Task.ts": `/**
 * @changes
 * @signedIn:list
 */
export type Task = {
  title: string;
  status: "open" | "done";
  /** @hidden */
  secret?: string;
};
`,
  "entities/Note.ts": "export type Note = { text: string };\n",
  "hooks/signedIn.ts": `import { definePreHook, HttpError } from "@quickservicets/core";
export default definePreHook((_repos, req) => {
  if (req.headers.get("x-anonymous")) throw new HttpError(401, "Sign in first");
});
`,
};
const send = (method: string, body?: unknown) => ({ method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

type Message = { event?: string; id?: string; data: { id: string; type: string; record: Record<string, unknown>; matches?: boolean } };

/** Reads the messages of an open stream as they arrive. */
function follow(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const messages: Message[] = [];
  let buffer = "";
  let ended = false;
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) break;
      buffer += decoder.decode(value);
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (block.startsWith(":")) continue;
        const fields = Object.fromEntries(block.split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]));
        messages.push({ ...(fields.event ? { event: fields.event } : {}), ...(fields.id ? { id: fields.id } : {}), data: JSON.parse(fields.data!) });
      }
    }
    ended = true;
  })();
  return {
    messages,
    async waitFor(count: number) {
      for (let tries = 0; tries < 200 && messages.length < count && !ended; tries++) await Bun.sleep(5);
      return messages;
    },
    async close() {
      await reader.cancel();
      await pump;
    },
  };
}

const create = async (service: TestService, body: Record<string, unknown>) => ((await (await service.fetch("/tasks", send("POST", body))).json()) as { id: string }).id;

describe("change streams", () => {
  test("creating a task sends created with the record as the list route returns it", async () => {
    const service = await startTestService({ files: FILES });
    try {
      const response = await service.fetch("/tasks/changes");
      expect([response.status, response.headers.get("content-type")]).toEqual([200, "text/event-stream; charset=utf-8"]);
      const stream = follow(response);
      const id = await create(service, { title: "Write docs", status: "open", secret: "s" });
      const [message] = await stream.waitFor(1);
      const listed = ((await (await service.fetch("/tasks")).json()) as { data: Record<string, unknown>[] }).data[0]!;
      expect(message!.event).toBe("created");
      expect(message!.id).toMatch(/^[0-9a-f]{8}-/);
      expect(message!.data).toEqual({ id, type: "task.created", record: JSON.parse(JSON.stringify(listed)) });
      expect(Object.keys(message!.data.record)).not.toContain("secret");
      await stream.close();
    } finally {
      await service.stop();
    }
  });

  test("filters: creates of open tasks only, an update leaving the filter with matches: false, no delete of a done task", async () => {
    const service = await startTestService({ files: FILES });
    try {
      const stream = follow(await service.fetch("/tasks/changes?where[status][eq]=open"));
      const open = await create(service, { title: "a", status: "open" });
      await create(service, { title: "b", status: "done" });
      await service.fetch(`/tasks/${open}`, send("PATCH", { status: "done" }));
      await service.fetch(`/tasks/${open}`, { method: "DELETE" });
      await create(service, { title: "c", status: "open" });
      const messages = await stream.waitFor(3);
      expect(messages.map((message) => [message.event, message.data.record.title, message.data.matches])).toEqual([
        ["created", "a", undefined],
        ["updated", "a", false],
        ["created", "c", undefined],
      ]);
      await stream.close();
    } finally {
      await service.stop();
    }
  });

  test("events=deleted, fields=title; invalid parameters answer 400 naming them; a list pre-hook refuses before opening", async () => {
    const service = await startTestService({ files: FILES });
    try {
      const deletes = follow(await service.fetch("/tasks/changes?events=deleted&fields=title"));
      const id = await create(service, { title: "a", status: "open" });
      await service.fetch(`/tasks/${id}`, { method: "DELETE" });
      const [deleted] = await deletes.waitFor(1);
      expect([deleted!.event, deleted!.data.record]).toEqual(["deleted", { id, title: "a" }]);
      await deletes.close();
      for (const [query, field] of [["events=moved", "events"], ["sort=title", "sort"], ["where[secret][eq]=x", "where[secret][eq]"]] as [string, string][]) {
        const refused = await service.fetch(`/tasks/changes?${query}`);
        const body = (await refused.json()) as { error: { details: { field: string }[] } };
        expect([refused.status, body.error.details.map((detail) => detail.field)]).toEqual([400, [field]]);
      }
      const anonymous = await service.fetch("/tasks/changes", { headers: { "x-anonymous": "1" } });
      expect([anonymous.status, anonymous.headers.get("content-type")]).toEqual([401, "application/json"]);
    } finally {
      await service.stop();
    }
  });

  test("no listener with the outbox; all covers every listed entity but @changes off; a covered entity without events fails startup", async () => {
    const registered: string[] = [];
    const original = events.on;
    events.on = ((pattern: string, listener: never, options?: never) => {
      registered.push(pattern);
      return original(pattern, listener, options);
    }) as typeof events.on;
    // With the outbox, the streams read the log and register no listener; the log is polled only while one is open.
    const service = await startTestService({ files: { ...FILES, "quickservicets.config.ts": config("events: { outbox: true }, realtime: { sse: { pollInterval: \"1s\" } }") } });
    try {
      await create(service, { title: "a", status: "open" });
      const stream = follow(await service.fetch("/tasks/changes"));
      await create(service, { title: "b", status: "open" });
      expect((await stream.waitFor(1)).map((message) => message.data.record.title)).toEqual(["b"]);
      expect(registered).toEqual([]);
      await stream.close();
    } finally {
      events.on = original;
      await service.stop();
    }
    const all = await startTestService({
      files: { ...FILES, "quickservicets.config.ts": config('events: {}, realtime: { sse: { changes: "all" } }'), "entities/Task.ts": "/** @changes off */\nexport type Task = { title: string };\n" },
    });
    try {
      expect((await all.fetch("/notes/changes")).status).toBe(200);
      expect((await all.fetch("/tasks/changes")).status).toBe(404);
    } finally {
      await all.stop();
    }
    await expect(startTestService({ files: { ...FILES, "quickservicets.config.ts": config("realtime: {}") } })).rejects.toThrow(
      "realtime change streams require events; add events: {} to quickservicets.config.ts",
    );
  });

  test("OpenAPI documents the change stream with its events and where parameters as text/event-stream", async () => {
    const service = await startTestService({ files: FILES });
    try {
      const document = JSON.parse(readFileSync(join(service.root, ".generated/openapi.json"), "utf8"));
      const operation = document.paths["/tasks/changes"].get;
      const names = operation.parameters.map((parameter: { name: string }) => parameter.name);
      expect(names).toContain("events");
      expect(names.some((name: string) => name.startsWith("where"))).toBe(true);
      expect(names).not.toContain("limit");
      expect(Object.keys(operation.responses["200"].content)).toEqual(["text/event-stream"]);
    } finally {
      await service.stop();
    }
  });
});
