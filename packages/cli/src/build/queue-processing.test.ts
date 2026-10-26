import { describe, expect, test } from "bun:test";
import { startTestService, type TestService } from "../testing/service.ts";

const config = (extra = "") => `import { defineConfig, memoryAdapter, type LogEntry } from "@quickservicets/core";
const entries = ((globalThis as { queueLogs?: LogEntry[] }).queueLogs = []);
const logger = { info: (entry: LogEntry) => void entries.push(entry), warn: (entry: LogEntry) => void entries.push(entry), error: (entry: LogEntry) => void entries.push(entry) };
export default defineConfig({ database: memoryAdapter(), logger, queues: { pollInterval: "1s" }${extra} });
`;
const logs = () => (globalThis as { queueLogs?: { message: string; messageId?: string; attempt?: number }[] }).queueLogs ?? [];
const post = (body: unknown = {}) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
type Message = { id: string; status: string; attempt: number; result?: unknown; lastError?: { message: string; stack?: string } | null };
type Repos = { queueMessages: { query(): { all(): Promise<Message[]> }; findById(id: string): Promise<Message | null> } };
const messages = (service: TestService) => (service.repos as unknown as Repos).queueMessages;
const settle = async (check: () => Promise<boolean>) => {
  for (let attempt = 0; attempt < 400 && !(await check()); attempt++) await Bun.sleep(10);
};

const files = (extra = "") => ({
  "quickservicets.config.ts": config(extra),
  "queues/send-email.ts": `import { queue } from "@quickservicets/core";
export default queue<{ to: string }>(async ({ payload, message }) => ({ sentTo: payload.to, attempt: message.attempt }));
`,
  "queues/stubborn.ts": `import { queue } from "@quickservicets/core";
export default queue(() => new Promise((resolve) => setTimeout(resolve, 5000)));
`,
  "endpoints/send/post.ts": `import type { ServiceRequest } from "@quickservicets/core";
export default async (_repos: unknown, req: ServiceRequest) => req.queue.add("send-email", (await req.json()) as { to: string });
`,
  "endpoints/stubborn/post.ts": `import type { ServiceRequest } from "@quickservicets/core";
export default async (_repos: unknown, req: ServiceRequest) => req.queue.add("stubborn", {});
`,
});

describe("processing in a running service", () => {
  test("added messages are processed and end completed with the handler's result", async () => {
    const service = await startTestService({ files: files() });
    try {
      const ids: string[] = [];
      for (const to of ["a@b.c", "d@e.f", "g@h.i"]) ids.push(((await (await service.fetch("/send", post({ to }))).json()) as { id: string }).id);
      await settle(async () => (await messages(service).query().all()).every((message) => message.status === "completed"));
      for (const [index, id] of ids.entries()) {
        expect(await messages(service).findById(id)).toMatchObject({ status: "completed", attempt: 1, result: { sentTo: ["a@b.c", "d@e.f", "g@h.i"][index], attempt: 1 } });
      }
    } finally {
      await service.stop();
    }
  });

  test("with QS_QUEUES_CONSUME=false the process adds messages but consumes none", async () => {
    const service = await startTestService({ files: files(), env: { QS_QUEUES_CONSUME: "false" } });
    try {
      for (const to of ["a@b.c", "d@e.f", "g@h.i"]) expect((await service.fetch("/send", post({ to }))).status).toBe(200);
      await Bun.sleep(100);
      expect((await messages(service).query().all()).map((message) => message.status)).toEqual(["waiting", "waiting", "waiting"]);
    } finally {
      await service.stop();
    }
  });

  test("stopping during a handler that ignores its signal returns the message to waiting uncounted, with no timer left", async () => {
    const service = await startTestService({ files: files(', jobs: { shutdownGrace: "1s" }') });
    let stopped = false;
    try {
      const { id } = (await (await service.fetch("/stubborn", post())).json()) as { id: string };
      await settle(async () => (await messages(service).findById(id))?.status === "active");
      const started = Date.now();
      stopped = true;
      // stop() also fails when a timer the native created is still active after onStop.
      await service.stop();
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
      // The message went back to waiting, uncounted, before the database disconnected.
      expect(logs().find((entry) => entry.message === "queue.message.interrupted")).toMatchObject({ messageId: id, attempt: 1 });
    } finally {
      if (!stopped) await service.stop();
    }
  });
});
