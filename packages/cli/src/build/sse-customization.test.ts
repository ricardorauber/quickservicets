import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService, type TestService } from "../testing/service.ts";
import { build } from "./build.ts";

const LOGGER = `logger: {
    info: (entry: object) => void ((globalThis as any).realtimeLogs ??= []).push(entry),
    warn: (entry: object) => void ((globalThis as any).realtimeLogs ??= []).push(entry),
    error: (entry: object) => void ((globalThis as any).realtimeLogs ??= []).push(entry),
  }`;
const config = (realtime = "{}", extra = "") => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), events: {}, realtime: ${realtime}, ${LOGGER}${extra ? `, ${extra}` : ""} });
`;
/** A project feature that signs requests in as the user of the x-user header. */
const SIGN_IN = `import { defineFeature } from "@quickservicets/core";
export default defineFeature({
  key: "signin",
  middleware: [{ stage: "handler", run: (req, _res, next) => { const id = req.headers.get("x-user"); if (id) (req as { user?: unknown }).user = { id }; return next(); } }],
});
`;
const FILES = {
  "quickservicets.config.ts": config(),
  "entities/Task.ts": '/** @changes */\nexport type Task = { title: string; owner?: string };\n',
  "endpoints/clock/sse.ts": 'import { defineSse } from "@quickservicets/core";\nexport default defineSse(() => undefined);\n',
};
const logs = () => ((globalThis as { realtimeLogs?: Record<string, unknown>[] }).realtimeLogs ??= []);
afterEach(() => {
  logs().length = 0;
});
const send = (method: string, body?: unknown) => ({ method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const create = async (service: TestService, body: Record<string, unknown>) => ((await (await service.fetch("/tasks", send("POST", body))).json()) as { id: string }).id;

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
  const data = () =>
    blocks.filter((block) => !block.startsWith(":")).map((block) => JSON.parse(block.split("\n").find((line) => line.startsWith("data: "))!.slice(6)) as { record: Record<string, unknown>; extra?: string });
  return {
    blocks,
    titles: () => data().map((item) => item.record.title),
    data,
    async waitFor(count: number, ms = 3000) {
      const until = Date.now() + ms;
      while (blocks.length < count && Date.now() < until) await Bun.sleep(5);
    },
    async close() {
      await reader.cancel();
      await pump;
    },
  };
}

describe("variables and the tag", () => {
  test("QS_REALTIME_SSE_HEARTBEAT=1s pings every second; QS_REALTIME_SSE_MAX_STREAMS=1 refuses a second stream", async () => {
    const service = await startTestService({ files: FILES, env: { QS_REALTIME_SSE_HEARTBEAT: "1s", QS_REALTIME_SSE_MAX_STREAMS: "1" } });
    try {
      const stream = follow(await service.fetch("/clock"));
      expect((await service.fetch("/clock")).status).toBe(503);
      await stream.waitFor(1, 2500);
      expect(stream.blocks[0]).toBe(": ping");
      await stream.close();
    } finally {
      await service.stop();
    }
  });

  test("@changes events=created offers only creates; other events answer 400; other tag options fail the build", async () => {
    const files = { ...FILES, "entities/Task.ts": "/** @changes events=created */\nexport type Task = { title: string };\n" };
    const service = await startTestService({ files });
    try {
      const refused = await service.fetch("/tasks/changes?events=deleted");
      expect([refused.status, ((await refused.json()) as { error: { details: { field: string }[] } }).error.details[0]!.field]).toEqual([400, "events"]);
      const stream = follow(await service.fetch("/tasks/changes"));
      const id = await create(service, { title: "a" });
      await service.fetch(`/tasks/${id}`, send("PATCH", { title: "b" }));
      await service.fetch(`/tasks/${id}`, { method: "DELETE" });
      await create(service, { title: "c" });
      await stream.waitFor(2);
      await Bun.sleep(20);
      expect(stream.titles()).toEqual(["a", "c"]);
      await stream.close();
    } finally {
      await service.stop();
    }
    const invalid = createLinkedProject({ ...FILES, "entities/Task.ts": "/** @changes level=high */\nexport type Task = { title: string };\n" });
    await expect(build(invalid)).rejects.toThrow("entities/Task.ts: invalid @changes: unknown option level");
  });
});

describe("hooks and the feature API", () => {
  test("beforeDeliver by owner gives each user their own tasks; a throwing beforeDeliver skips and logs", async () => {
    const files = {
      ...FILES,
      "features/signin/index.ts": SIGN_IN,
      "quickservicets.config.ts": config(
        '{ sse: { beforeDeliver: ({ user, event }) => { if ((event.after as any)?.title === "boom") throw new Error("hook broke"); return (event.after as any)?.owner === user?.id; } } }',
        "signin: {}",
      ),
    };
    const service = await startTestService({ files });
    try {
      const ana = follow(await service.fetch("/tasks/changes", { headers: { "x-user": "ana" } }));
      const bob = follow(await service.fetch("/tasks/changes", { headers: { "x-user": "bob" } }));
      await create(service, { title: "ana's", owner: "ana" });
      await create(service, { title: "boom", owner: "ana" });
      await create(service, { title: "bob's", owner: "bob" });
      await ana.waitFor(1);
      await bob.waitFor(1);
      await Bun.sleep(30);
      expect([ana.titles(), bob.titles()]).toEqual([["ana's"], ["bob's"]]);
      expect(logs().some((entry) => entry.message === "feature.hook.failed" && entry.hook === "sse.beforeDeliver")).toBe(true);
      await ana.close();
      await bob.close();
    } finally {
      await service.stop();
    }
  });

  test("beforeSend changes or skips messages; a feature's beforeSend runs after the config's, and publish reaches open streams", async () => {
    const feature = `import { defineFeature, type WriteEvent } from "@quickservicets/core";
export default defineFeature({
  key: "announcer",
  requires: ["realtime"],
  setup(ctx) {
    const realtime = ctx.feature("realtime");
    realtime.beforeSend((step) => step && { ...step, data: { ...(step.data as object), extra: ((step.data as { extra?: string }).extra ?? "") + "+feature" } });
    (globalThis as any).realtimeApi = realtime;
  },
});
`;
    const files = {
      ...FILES,
      "features/announcer/index.ts": feature,
      "quickservicets.config.ts": config(
        '{ sse: { beforeSend: ({ event, data }) => ((event.after as any)?.title === "hidden" ? null : { ...(data as object), extra: "config" }) } }',
        "announcer: {}",
      ),
    };
    const service = await startTestService({ files });
    try {
      const stream = follow(await service.fetch("/tasks/changes"));
      await create(service, { title: "hidden" });
      await create(service, { title: "shown" });
      await stream.waitFor(1);
      const api = (globalThis as { realtimeApi?: { publish(entity: string, event: object): void } }).realtimeApi!;
      const now = new Date();
      api.publish("Task", { id: Bun.randomUUIDv7(), type: "task.created", entity: "Task", operation: "created", recordId: "p1", before: null, after: { id: "p1", title: "published", createdAt: now, updatedAt: now }, changed: [], cause: "write", actor: {}, at: now });
      await stream.waitFor(2);
      expect(stream.titles()).toEqual(["shown", "published"]);
      expect(stream.data()[0]!.extra).toBe("config+feature");
      await stream.close();
    } finally {
      await service.stop();
    }
  });
});

describe("override files and the change source", () => {
  test("a project endpoints/tasks/changes/sse.ts replaces the generated change stream, with an override line", async () => {
    const files = { ...FILES, "endpoints/tasks/changes/sse.ts": 'import { defineSse } from "@quickservicets/core";\nexport default defineSse((stream) => stream.send("custom"));\n' };
    const summary = await build(createLinkedProject(files));
    expect((summary.buildSteps ?? []).flatMap((step) => step.lines)).toContain("Override: endpoints/tasks/changes/sse.ts replaces GET /tasks/changes from realtime");
    const service = await startTestService({ files });
    try {
      const stream = follow(await service.fetch("/tasks/changes"));
      await stream.waitFor(1);
      expect(stream.blocks[0]).toBe("data: custom");
      await stream.close();
    } finally {
      await service.stop();
    }
  });

  test("a memory changeSource feeds live and replayed events, and the outbox is not polled", async () => {
    const source = `const events: any[] = ((globalThis as any).sourceEvents = []);
const listeners = new Set<(event: any) => void>();
export const memorySource = {
  subscribe(entities: readonly string[], onEvent: (event: any) => void) {
    const listener = (event: any) => entities.includes(event.entity) && onEvent(event);
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  async replay(entities: readonly string[], afterId: string) {
    const at = events.findIndex((event) => event.id === afterId);
    return at < 0 ? "expired" : events.slice(at + 1).filter((event) => entities.includes(event.entity));
  },
  push(event: any) {
    events.push(event);
    for (const listener of listeners) listener(event);
  },
};
`;
    const event = (title: string) => {
      const now = new Date().toISOString();
      return { id: Bun.randomUUIDv7(), type: "task.created", entity: "Task", operation: "created", recordId: title, before: null, after: { id: title, title, createdAt: now, updatedAt: now }, changed: [], cause: "write", actor: {}, at: now };
    };
    const files = {
      ...FILES,
      "source.ts": source,
      "quickservicets.config.ts": config("{ sse: { changeSource: memorySource } }").replace("events: {}", "events: { outbox: true }").replace('import { defineConfig, memoryAdapter } from "@quickservicets/core";', 'import { defineConfig, memoryAdapter } from "@quickservicets/core";\nimport { memorySource } from "./source.ts";'),
    };
    const service = await startTestService({ files });
    try {
      const { memorySource } = (await import(join(service.root, "source.ts"))) as { memorySource: { push(event: object): void } };
      const first = event("first");
      memorySource.push(first);
      memorySource.push(event("missed"));
      const stream = follow(await service.fetch("/tasks/changes", { headers: { "last-event-id": first.id } }));
      await stream.waitFor(1);
      memorySource.push(event("live"));
      await stream.waitFor(2);
      expect(stream.titles()).toEqual(["missed", "live"]);
      await stream.close();
      const expired = follow(await service.fetch("/tasks/changes", { headers: { "last-event-id": Bun.randomUUIDv7() } }));
      await expired.waitFor(1);
      expect(expired.blocks[0]).toBe('event: reset\nretry: 3000\ndata: {"reason":"expired"}');
      await expired.close();
    } finally {
      await service.stop();
    }
  });
});

describe("the reference page", () => {
  test("lists the options with their variables, the tag and the feature API", () => {
    const page = readFileSync(join(import.meta.dir, "../../../../docs/src/content/docs/reference/features/realtime.mdx"), "utf8");
    for (const text of ["`realtime.sse.heartbeat`", "`QS_REALTIME_SSE_HEARTBEAT`", "`QS_REALTIME_SSE_MAX_STREAMS`", "### `@changes`", "`realtime.sse.beforeDeliver`", "`realtime.sse.changeSource`", "## Feature API", "### `publish`"]) {
      expect(page).toContain(text);
    }
  });
});
