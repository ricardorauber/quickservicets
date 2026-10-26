import { afterEach, describe, expect, test } from "bun:test";
import type { ErrorReport } from "@quickservicets/core";
import { startTestService, type TestService } from "../testing/service.ts";

const LOGGER = `logger: {
    info: (entry: object) => void ((globalThis as any).outsideLogs ??= []).push(entry),
    warn: (entry: object) => void ((globalThis as any).outsideLogs ??= []).push(entry),
    error: (entry: object) => void ((globalThis as any).outsideLogs ??= []).push(entry),
  }`;
const config = (keys: string) => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
import { memoryReporter, throwingReporter, slowReporter, stuckReporter } from "./reporters.ts";
export default defineConfig({ database: memoryAdapter(), ${keys}, ${LOGGER} });
`;
const REPORTERS = `import type { ErrorReport } from "@quickservicets/core";
const received: ErrorReport[] = ((globalThis as any).outsideReports ??= []);
export const memoryReporter = { report: (report: ErrorReport) => void received.push(report) };
export const throwingReporter = { report: () => { throw new Error("reporter down"); } };
export const slowReporter = {
  report: (report: ErrorReport) => new Promise<void>((resolve) => setTimeout(() => { received.push({ ...report, tags: { ...report.tags, slow: "delivered" } }); resolve(); }, 50)),
  flush: () => new Promise<void>((resolve) => setTimeout(() => { (globalThis as any).flushed = true; resolve(); }, 20)),
};
export const stuckReporter = { report: () => undefined, flush: () => new Promise<void>(() => undefined) };
`;
/** A project feature that signs requests in as the user of the x-user header. */
const SIGN_IN = `import { defineFeature } from "@quickservicets/core";
export default defineFeature({
  key: "signin",
  middleware: [{ stage: "handler", run: (req, _res, next) => { const id = req.headers.get("x-user"); if (id) (req as { user?: unknown }).user = { id }; return next(); } }],
});
`;
const FILES = {
  "reporters.ts": REPORTERS,
  "features/signin/index.ts": SIGN_IN,
  "entities/User.ts": "export type User = { name: string };\n",
  "queues/flaky.ts": 'import { queue } from "@quickservicets/core";\nexport default queue(() => { throw new Error("consumer broke"); }, { retries: 2, retryDelay: "1s" });\n',
  "endpoints/enqueue/post.ts": 'import type { ServiceRequest } from "@quickservicets/core";\nexport default async (_repos: unknown, req: ServiceRequest) => req.queue.add("flaky", {});\n',
  "events/broken.ts": 'import { listen } from "@quickservicets/core";\nexport default listen("user.created", () => { throw new Error("listener broke"); });\n',
};
const reports = () => ((globalThis as { outsideReports?: ErrorReport[] }).outsideReports ??= []);
const logs = () => ((globalThis as { outsideLogs?: Record<string, unknown>[] }).outsideLogs ??= []);
afterEach(() => {
  reports().length = 0;
  logs().length = 0;
});
const post = (body: unknown = {}, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const settle = async (check: () => boolean | Promise<boolean>, tries = 600) => {
  for (let attempt = 0; attempt < tries && !(await check()); attempt++) await Bun.sleep(10);
};
type Message = { status: string; attempt: number };
const messages = (service: TestService) => (service.repos as unknown as { queueMessages: { query(): { toArray(): Promise<Message[]> } } }).queueMessages.query().toArray();

describe("queue messages", () => {
  test("a message that exhausts its retries is reported once, with the user of the request that added it", async () => {
    const service = await startTestService({ files: { ...FILES, "quickservicets.config.ts": config('events: {}, queues: { pollInterval: "1s" }, signin: {}, errors: { reporter: memoryReporter }') } });
    try {
      const { id } = (await (await service.fetch("/enqueue", post({}, { "x-user": "u1" }))).json()) as { id: string };
      await settle(async () => (await messages(service)).every((message) => message.status === "dead"));
      await settle(() => reports().some((report) => report.kind === "queue"));
      const queued = reports().filter((report) => report.kind === "queue");
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ queue: { name: "flaky", messageId: id, attempt: 3 }, user: { id: "u1" }, error: { message: "consumer broke" } });
      expect(queued[0]!.requestId).toBeString();
    } finally {
      await service.stop();
    }
  }, 15_000);

  test('with jobs: "every" each failed attempt is reported too', async () => {
    const service = await startTestService({ files: { ...FILES, "quickservicets.config.ts": config('events: {}, queues: { pollInterval: "1s" }, signin: {}, errors: { reporter: memoryReporter, jobs: "every" }') } });
    try {
      await service.fetch("/enqueue", post());
      await settle(async () => (await messages(service)).every((message) => message.status === "dead"));
      await settle(() => reports().filter((report) => report.kind === "queue").length >= 4);
      // Each of the three failed attempts, then the message that became dead.
      expect(reports().filter((report) => report.kind === "queue").map((report) => report.queue!.attempt)).toEqual([1, 2, 3, 3]);
    } finally {
      await service.stop();
    }
  }, 15_000);
});

describe("events", () => {
  test("an after-commit listener that throws is reported with the event type and the request's user", async () => {
    const service = await startTestService({ files: { ...FILES, "quickservicets.config.ts": config("events: {}, queues: {}, signin: {}, errors: { reporter: memoryReporter }") } });
    try {
      await service.fetch("/users", post({ name: "Ada" }, { "x-user": "u1" }));
      await settle(() => reports().some((report) => report.kind === "event"));
      expect(reports().find((report) => report.kind === "event")).toMatchObject({ tags: { event: "user.created" }, user: { id: "u1" }, error: { message: "listener broke" } });
    } finally {
      await service.stop();
    }
  });

  test("an outbox delivery that becomes failed is reported with its consumer", async () => {
    const consumer = `import { defineFeature } from "@quickservicets/core";
export default defineFeature({
  key: "mailer",
  requires: ["events"],
  setup(ctx) {
    ctx.feature("events").deliver("welcome-mail", { pattern: "user.created", retries: 1, handler: () => { throw new Error("smtp down"); } });
  },
});
`;
    const service = await startTestService({
      files: {
        ...FILES,
        "features/mailer/index.ts": consumer,
        "quickservicets.config.ts": config('events: { outbox: { delivery: { pollInterval: "1s" } } }, queues: {}, signin: {}, mailer: {}, errors: { reporter: memoryReporter }'),
      },
    });
    try {
      await service.fetch("/users", post({ name: "Ada" }));
      await settle(() => reports().some((report) => report.tags.consumer === "welcome-mail"));
      expect(reports().find((report) => report.tags.consumer === "welcome-mail")).toMatchObject({ kind: "event", tags: { consumer: "welcome-mail", event: "user.created" }, error: { message: "smtp down" } });
    } finally {
      await service.stop();
    }
  });

  test("with a reporter that throws, queue statuses, attempts and responses are the same", async () => {
    const service = await startTestService({ files: { ...FILES, "quickservicets.config.ts": config('events: {}, queues: { pollInterval: "1s" }, signin: {}, errors: { reporter: throwingReporter }') } });
    try {
      expect((await service.fetch("/users", post({ name: "Ada" }))).status).toBe(201);
      await service.fetch("/enqueue", post());
      await settle(async () => (await messages(service)).every((message) => message.status === "dead"));
      expect((await messages(service)).map((message) => [message.status, message.attempt])).toEqual([["dead", 3]]);
      expect(logs().some((entry) => entry.message === "error.report.failed")).toBe(true);
    } finally {
      await service.stop();
    }
  }, 15_000);
});

describe("flush on shutdown", () => {
  test("stopping waits for a slow reporter's pending report and its flush", async () => {
    const service = await startTestService({ files: { ...FILES, "quickservicets.config.ts": config("events: {}, queues: {}, signin: {}, errors: { reporter: slowReporter }") } });
    const { reportError } = await import("@quickservicets/core");
    reportError(new Error("late"));
    await service.stop();
    expect(reports().map((report) => report.tags.slow)).toEqual(["delivered"]);
    expect((globalThis as { flushed?: boolean }).flushed).toBe(true);
  });

  test("a flush that never resolves logs error.flush.timeout after the stop timeout and the stop still completes", async () => {
    const service = await startTestService({ files: { ...FILES, "quickservicets.config.ts": config('events: {}, queues: {}, signin: {}, errors: { reporter: stuckReporter }, lifecycle: { stopTimeout: "1s" }') } });
    const started = Date.now();
    await service.stop();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(logs().some((entry) => entry.message === "error.flush.timeout")).toBe(true);
  });
});
