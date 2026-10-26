import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { events, registerProjectFeatures } from "@quickservicets/core";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService, type TestService } from "../testing/service.ts";
import { build } from "./build.ts";

afterEach(() => registerProjectFeatures([]));

type Message = { id: string; queue: string; status: string; attempt: number; priority: number; payload: Record<string, unknown> };
type Repos = { queueMessages: { query(): { toArray(): Promise<Message[]> }; findById(id: string): Promise<Message | null> } };
const messages = async (service: TestService) => (service.repos as unknown as Repos).queueMessages.query().toArray();
const post = (body: unknown = {}, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const settle = async (check: () => boolean | Promise<boolean>) => {
  for (let attempt = 0; attempt < 400 && !(await check()); attempt++) await Bun.sleep(10);
};
const g = globalThis as unknown as { gate?: { running: number; peak: number; release: Promise<void> }; seen?: unknown[]; dead?: unknown[]; logs?: { message: string; hook?: string }[] };

const config = (queues: string, extra = "") => `import { defineConfig, memoryAdapter, HttpError, type LogEntry } from "@quickservicets/core";
const logs = ((globalThis as { logs?: LogEntry[] }).logs = []);
const logger = { info: (entry: LogEntry) => void logs.push(entry), warn: (entry: LogEntry) => void logs.push(entry), error: (entry: LogEntry) => void logs.push(entry) };
export default defineConfig({ database: memoryAdapter(), logger, queues: ${queues}${extra} });
`;
const ADD = {
  "endpoints/add/post.ts": `import type { QueueAddOptions, ServiceRequest } from "@quickservicets/core";
export default async (_repos: unknown, req: ServiceRequest) => {
  const { name = "send-email", payload = {}, options } = (await req.json()) as { name?: "send-email"; payload?: { to?: string }; options?: QueueAddOptions };
  return req.queue.add(name, payload as never, options);
};
`,
};
const GATED = `import { queue } from "@quickservicets/core";
export default queue(async () => {
  const gate = (globalThis as unknown as { gate: { running: number; peak: number; release: Promise<void> } }).gate;
  gate.running++;
  gate.peak = Math.max(gate.peak, gate.running);
  await gate.release;
  gate.running--;
}, { concurrency: 2 });
`;

describe("option precedence", () => {
  const peakWith = async (queues: string, env: Record<string, string> = {}) => {
    const release = Promise.withResolvers<void>();
    g.gate = { running: 0, peak: 0, release: release.promise };
    const service = await startTestService({ files: { "quickservicets.config.ts": config(queues), "queues/send-email.ts": GATED, ...ADD }, env });
    try {
      for (let n = 0; n < 10; n++) await service.fetch("/add", post());
      // Every free slot is claimed at once after an add, so the count settles quickly.
      await settle(() => g.gate!.running >= 2);
      await Bun.sleep(150);
      return g.gate!.peak;
    } finally {
      release.resolve();
      await settle(async () => (await messages(service)).every((message) => message.status === "completed"));
      await service.stop();
    }
  };

  test("the override variable wins over the config override, which wins over the queue file", async () => {
    const overrides = `{ overrides: { "send-email": { concurrency: 4 } } }`;
    expect(await peakWith(overrides, { QS_QUEUES_OVERRIDES_SEND_EMAIL_CONCURRENCY: "8" })).toBe(8);
    expect(await peakWith(overrides)).toBe(4);
    expect(await peakWith("{}")).toBe(2);
    // The queues option and its variable come after the queue file.
    expect(await peakWith("{ concurrency: 3 }", { QS_QUEUES_CONCURRENCY: "5" })).toBe(2);
  }, 30_000);

  test("an override naming no queue is a config warning", async () => {
    const root = createLinkedProject({ "quickservicets.config.ts": config(`{ overrides: { nope: {} } }`), "queues/send-email.ts": GATED });
    expect((await build(root)).warnings).toContain("queues.overrides.nope matches no queue");
    const service = await startTestService({ files: { "quickservicets.config.ts": config(`{ overrides: { nope: {} } }`), "queues/send-email.ts": GATED } });
    try {
      expect(g.logs!.find((entry) => entry.message === "config.warning")).toMatchObject({ warning: "queues.overrides.nope matches no queue" });
    } finally {
      await service.stop();
    }
  });
});

describe("environment", () => {
  const FAILING = `import { queue } from "@quickservicets/core";\nexport default queue(() => { throw new Error("no"); });\n`;
  test("QS_QUEUES_RETRIES=0 makes a failing message dead after one attempt; QS_QUEUES_CONSUME=false and QS_QUEUES_ENABLED=false run no consumer", async () => {
    const service = await startTestService({ files: { "quickservicets.config.ts": config("{}"), "queues/send-email.ts": FAILING, ...ADD }, env: { QS_QUEUES_RETRIES: "0" } });
    try {
      await service.fetch("/add", post());
      await settle(async () => (await messages(service))[0]?.status === "dead");
      expect((await messages(service))[0]).toMatchObject({ status: "dead", attempt: 1 });
    } finally {
      await service.stop();
    }
    const idle = await startTestService({ files: { "quickservicets.config.ts": config("{}"), "queues/send-email.ts": FAILING, ...ADD }, env: { QS_QUEUES_CONSUME: "false" } });
    try {
      await idle.fetch("/add", post());
      await Bun.sleep(100);
      expect((await messages(idle))[0]).toMatchObject({ status: "waiting", attempt: 0 });
    } finally {
      await idle.stop();
    }
    const off = await startTestService({ files: { "quickservicets.config.ts": config("{}"), "queues/send-email.ts": FAILING }, env: { QS_QUEUES_ENABLED: "false" } });
    try {
      // The native is off: no consumer starts, so no cleanup runs either.
      await Bun.sleep(50);
      expect(g.logs!.some((entry) => entry.message === "queue.cleanup")).toBe(false);
    } finally {
      await off.stop();
    }
  });
});

describe("per-request defaults", () => {
  test("defaultPriority as a function of the request sets the priority of calls without one", async () => {
    const service = await startTestService({
      files: {
        "quickservicets.config.ts": config(`{ consume: false, defaultPriority: ({ req }) => (req?.headers.get("x-vip") ? 10 : 0), defaultDelay: ({ req }) => (req?.headers.get("x-later") ? "1m" : "0s") }`),
        "queues/send-email.ts": GATED,
        ...ADD,
      },
    });
    try {
      const vip = (await (await service.fetch("/add", post({}, { "x-vip": "1" }))).json()) as { id: string };
      const plain = (await (await service.fetch("/add", post())).json()) as { id: string };
      const explicit = (await (await service.fetch("/add", post({ options: { priority: -3 } }, { "x-vip": "1" }))).json()) as { id: string };
      const before = Date.now();
      const later = (await (await service.fetch("/add", post({}, { "x-later": "1" }))).json()) as { id: string };
      const repos = (service.repos as unknown as Repos).queueMessages;
      expect((await repos.findById(vip.id))!.priority).toBe(10);
      expect((await repos.findById(plain.id))!.priority).toBe(0);
      expect((await repos.findById(explicit.id))!.priority).toBe(-3);
      expect(((await repos.findById(later.id)) as unknown as { runAt: Date }).runAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);
    } finally {
      await service.stop();
    }
  });
});

describe("hooks and events", () => {
  test("beforeEnqueue changes or cancels an add, onDead sees dead messages, a throwing afterProcess is only logged, and events carry the outcomes", async () => {
    g.seen = [];
    g.dead = [];
    const service = await startTestService({
      files: {
        "quickservicets.config.ts": config(
          `{
    retries: 0,
    beforeEnqueue: (step) => {
      const payload = step.payload as { to?: string };
      if (payload.to === "blocked@b.c") throw new HttpError(403, "Blocked");
      return { ...step, payload: { ...payload, source: "api" } };
    },
    onDead: ({ message, error }) => void (globalThis as { dead?: unknown[] }).dead!.push({ id: message.id, error: (error as Error).message }),
    afterProcess: () => {
      throw new Error("after failed");
    },
  }`,
          ", events: {}",
        ),
        "queues/send-email.ts": `import { queue } from "@quickservicets/core";
export default queue<{ to: string; source?: string }>(({ payload }) => {
  (globalThis as { seen?: unknown[] }).seen!.push(payload);
  if (payload.to === "fail@b.c") throw new Error("smtp down");
});
`,
        ...ADD,
      },
    });
    const received: { type: string; messageId: string }[] = [];
    const off = events.on("queue.message.*", (event) => void received.push({ type: event.type, messageId: (event as unknown as { payload: { messageId: string } }).payload.messageId }));
    try {
      const ok = (await (await service.fetch("/add", post({ payload: { to: "a@b.c" } }))).json()) as { id: string };
      await settle(async () => (await messages(service)).every((message) => message.status === "completed"));
      expect(g.seen).toEqual([{ to: "a@b.c", source: "api" }]);
      expect((await service.fetch("/add", post({ payload: { to: "blocked@b.c" } }))).status).toBe(403);
      expect(await messages(service)).toHaveLength(1);
      const failing = (await (await service.fetch("/add", post({ payload: { to: "fail@b.c" } }))).json()) as { id: string };
      await settle(() => (g.dead ?? []).length === 1 && received.some((event) => event.type === "queue.message.dead"));
      expect(g.dead).toEqual([{ id: failing.id, error: "smtp down" }]);
      expect(g.logs!.filter((entry) => entry.message === "feature.hook.failed").map((entry) => entry.hook)).toEqual(["afterProcess", "afterProcess"]);
      expect((await (service.repos as unknown as Repos).queueMessages.findById(ok.id))!.status).toBe("completed");
      expect(received).toEqual([
        { type: "queue.message.completed", messageId: ok.id },
        { type: "queue.message.failed", messageId: failing.id },
        { type: "queue.message.dead", messageId: failing.id },
      ]);
    } finally {
      off();
      await service.stop();
    }
  });
});

describe("override files", () => {
  test("a project queue file replaces the queue of a project feature, with an override line", async () => {
    const root = createLinkedProject({
      "quickservicets.config.ts": config("{}", ", example: {}"),
      "features/example/index.ts": 'import { defineFeature } from "@quickservicets/core";\nexport default defineFeature({ key: "example" });\n',
      "features/example/queues/notify.ts": 'import { queue } from "@quickservicets/core";\nexport default queue(() => "feature");\n',
      "queues/example/notify.ts": 'import { queue } from "@quickservicets/core";\nexport default queue(() => "project");\n',
    });
    const summary = await build(root);
    expect(summary.overrides).toContain("Override: queues/example/notify.ts replaces features/example/queues/notify.ts from example");
    const { featureFolders } = await import(join(root, ".generated/features.ts"));
    expect(await (featureFolders.queues.queues.get("example/notify") as { handler(): unknown }).handler()).toBe("project");
  });
});

describe("reference", () => {
  test("the reference page lists the variables, the per-queue pattern, the hooks, @publish and the commands", () => {
    const page = readFileSync(join(import.meta.dir, "../../../../docs/src/content/docs/reference/features/queues.mdx"), "utf8");
    for (const text of ["QS_QUEUES_CONCURRENCY", "QS_QUEUES_OVERRIDES_<NAME>_CONCURRENCY", "beforeEnqueue", "afterEnqueue", "beforeProcess", "afterProcess", "onDead", "@publish", "quickservicets queue list", "quickservicets queue retry"]) {
      expect(page).toContain(text);
    }
  });
});
