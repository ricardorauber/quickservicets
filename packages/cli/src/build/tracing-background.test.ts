import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { startTestService, type TestService } from "../testing/service.ts";
import { recordingTracer } from "../../../core/src/tracing-test-support.ts";

type Tracer = ReturnType<typeof recordingTracer>;
const holder = globalThis as { testTracer?: Tracer };

const CONFIG = (extra = "") => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({
  database: memoryAdapter(),
  logger: { info() {}, warn() {}, error() {} },
  ${extra}
});
`;
const TRACER_FEATURE = `import { defineFeature, setTracer } from "@quickservicets/core";
export default defineFeature({
  key: "tracer",
  enabledByDefault: true,
  setup() {
    const tracer = (globalThis as any).testTracer;
    if (tracer) setTracer(tracer);
  },
});
`;
const SINK = `import { defineFeature } from "@quickservicets/core";
export default defineFeature({
  key: "sink",
  enabledByDefault: true,
  requires: ["events"],
  setup(ctx) {
    ctx.events.deliver("audit-sink", { pattern: "user.*", handler: () => {} });
  },
});
`;
const FILES = {
  "features/tracer/index.ts": TRACER_FEATURE,
  "entities/User.ts": "export type User = {\n  /** @unique */\n  name: string;\n};\n",
  "entities/Post.ts": "/** @stamp */\nexport type Post = { title: string; author?: User };\nimport type { User } from \"./User\";\n",
  "hooks/stamp.ts": 'import { definePreHook } from "@quickservicets/core";\nexport default definePreHook((_repos, req) => { req.context.stamped = true; });\n',
  "endpoints/rollback/post.ts": `import type { Repositories } from "@quickservicets/core";
export default async (repos: Repositories) => {
  await repos.transaction(async () => { await (repos as any).users.create({ name: "temp" }); throw new Error("undo"); }).catch(() => {});
  return { ok: true };
};
`,
};
const QUEUE_FILES = {
  "queues/send-email.ts": 'import { queue } from "@quickservicets/core";\nexport default queue<{ to: string }>(async ({ payload }) => ({ sentTo: payload.to }));\n',
  "endpoints/send/post.ts": `import type { ServiceRequest } from "@quickservicets/core";
export default async (_repos: unknown, req: ServiceRequest) => req.queue.add("send-email", { to: "a@b.c" });
`,
};
const EVENT_FILES = {
  "events/welcome.ts": 'import { listen } from "@quickservicets/core";\nexport default listen("user.created", async () => {});\n',
  "features/sink/index.ts": SINK,
};

const running: TestService[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
  delete holder.testTracer;
});

async function start(extra = "", files: Record<string, string> = {}, traced = true) {
  const tracer = traced ? recordingTracer() : undefined;
  if (tracer) holder.testTracer = tracer;
  const service = await startTestService({ files: { "quickservicets.config.ts": CONFIG(extra), ...FILES, ...files } });
  running.push(service);
  return { service, tracer: tracer! };
}

const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const until = async (check: () => boolean | Promise<boolean>) => {
  for (let tries = 0; tries < 400 && !(await check()); tries++) await Bun.sleep(10);
};

describe("repository spans", () => {
  test("reads and populate steps run in client spans under the server span, without statements; a failing insert records error.type", async () => {
    const { service, tracer } = await start();
    const user = (await (await service.fetch("/users", post({ name: "ann" }))).json()) as { id: string };
    await service.fetch("/posts", post({ title: "hello", author: user.id }));
    tracer.spans.length = 0;
    expect((await service.fetch("/posts?populate=author")).status).toBe(200);
    const server = tracer.spans.find((span) => span.kind === "server")!;
    const posts = tracer.named("findMany posts")[0]!;
    const users = tracer.named("findMany users")[0]!;
    for (const span of [posts, users]) {
      expect(span.kind).toBe("client");
      expect(span.context().traceId).toBe(server.context().traceId);
      expect(span.attributes).toMatchObject({ "db.system.name": "memory", "db.operation.name": "findMany", "db.response.returned_rows": 1 });
    }
    expect(posts.attributes["db.collection.name"]).toBe("posts");
    expect(posts.attributes["quickservicets.entity"]).toBe("Post");
    expect(posts.parent).toEqual(server.context());
    expect(JSON.stringify(tracer.spans.map((span) => span.attributes))).not.toMatch(/select|hello/i);

    tracer.spans.length = 0;
    expect((await service.fetch("/users", post({ name: "ann" }))).status).toBe(409);
    const insert = tracer.named("insert users")[0]!;
    expect(insert.status).toEqual({ code: "error" });
    expect(typeof insert.attributes["error.type"]).toBe("string");
  });
});

describe("transaction and hook spans", () => {
  test("a rolled-back transaction records a rollback event, and an entity pre-hook runs in hook <name>", async () => {
    const { service, tracer } = await start();
    await service.fetch("/rollback", { method: "POST" });
    const transaction = tracer.named("transaction");
    expect(transaction).toHaveLength(1);
    expect(transaction[0]!.events.map((event) => event.name)).toContain("rollback");
    expect(transaction[0]!.status).toEqual({ code: "error" });
    expect(tracer.named("insert users")[0]!.parent).toEqual(transaction[0]!.context());

    tracer.spans.length = 0;
    await service.fetch("/posts", post({ title: "x" }));
    const server = tracer.spans.find((span) => span.kind === "server")!;
    const hook = tracer.named("hook stamp")[0]!;
    expect(hook.kind).toBe("internal");
    expect(hook.parent).toEqual(server.context());
    expect(hook.ended).toBe(true);
  });
});

describe("queue spans", () => {
  test("queues.add runs in a producer span, the message stores trace, and its run starts a new trace linked to it", async () => {
    const { service, tracer } = await start(`queues: { pollInterval: "50ms" },`, QUEUE_FILES);
    const added = (await (await service.fetch("/send", { method: "POST" })).json()) as { id: string };
    const send = tracer.named("send send-email")[0]!;
    expect(send.kind).toBe("producer");
    expect(send.attributes).toMatchObject({ "messaging.system": "quickservicets", "messaging.destination.name": "send-email", "messaging.message.id": added.id });
    const messages = (service.repos as unknown as { queueMessages: { findById(id: string): Promise<{ status: string; trace?: string }> } }).queueMessages;
    expect((await messages.findById(added.id)).trace).toBe(`00-${send.context().traceId}-${send.context().spanId}-01`);
    await until(async () => (await messages.findById(added.id)).status === "completed");
    await until(() => tracer.named("process send-email").some((span) => span.ended));
    const processed = tracer.named("process send-email")[0]!;
    expect(processed.kind).toBe("consumer");
    expect(processed.parent).toBeNull();
    expect(processed.links[0]!.context).toEqual(send.context());
    expect(processed.attributes).toMatchObject({ "messaging.destination.name": "send-email", "messaging.message.id": added.id, "quickservicets.queue.attempt": 1 });
  });
});

describe("event spans and the disabled path", () => {
  test("listener files and outbox deliveries run in spans linked to the request's span", async () => {
    const { service, tracer } = await start(`events: { outbox: true },`, EVENT_FILES);
    await service.fetch("/users", post({ name: "bea" }));
    await until(() => tracer.named("event user.created").some((span) => span.ended) && tracer.named("deliver audit-sink").some((span) => span.ended));
    const server = tracer.spans.find((span) => span.kind === "server" && span.name === "POST /users")!;
    const listener = tracer.named("event user.created")[0]!;
    expect(listener.kind).toBe("internal");
    expect(listener.parent).toBeNull();
    expect(listener.links[0]!.context).toEqual(server.context());
    const delivery = tracer.named("deliver audit-sink")[0]!;
    expect(delivery.kind).toBe("consumer");
    expect(delivery.links[0]!.context.spanId).toBe(server.context().spanId);
  });

  test("without a tracer, messages store no trace and repositories make no tracing call", async () => {
    const tracing = await import("../../../core/src/tracing.ts");
    const start_ = spyOn(tracing, "startSpan");
    try {
      const { service } = await start(`queues: { pollInterval: "50ms" },`, QUEUE_FILES, false);
      await service.fetch("/users", post({ name: "cy" }));
      await service.fetch("/users");
      const added = (await (await service.fetch("/send", { method: "POST" })).json()) as { id: string };
      const messages = (service.repos as unknown as { queueMessages: { findById(id: string): Promise<{ trace?: string | null }> } }).queueMessages;
      expect((await messages.findById(added.id)).trace ?? undefined).toBeUndefined();
      expect(start_).not.toHaveBeenCalled();
    } finally {
      start_.mockRestore();
    }
  });
});
