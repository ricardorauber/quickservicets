import { describe, expect, test } from "bun:test";
import { startTestService, type TestService } from "../testing/service.ts";

const post = (body: unknown = {}) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
type Message = { queue: string; maxAttempts: number; priority: number; runAt: Date };
type Repos = { queueMessages: { findById(id: string): Promise<Message | null> } };
const messages = (service: TestService) => (service.repos as unknown as Repos).queueMessages;

const files = {
  "quickservice.config.ts": `import { defineConfig, memoryAdapter } from "@quickservice/core";
export default defineConfig({ database: memoryAdapter(), queues: {} });
`,
  "queues/once.ts": `import { queue } from "@quickservice/core";
export default queue(() => {}, { retries: 1 });
`,
  "queues/usual.ts": `import { queue } from "@quickservice/core";
export default queue(() => {});
`,
  "endpoints/add/post.ts": `import type { QueueAddOptions, ServiceRequest } from "@quickservice/core";
export default async (_repos: unknown, req: ServiceRequest) => {
  const { name, options } = (await req.json()) as { name: "once" | "usual"; options?: QueueAddOptions };
  try {
    return await req.queue.add(name, {}, options);
  } catch (error) {
    return { error: (error as Error).message };
  }
};
`,
};

describe("queue options", () => {
  test("a queue file's retries set maxAttempts at enqueue time, over the queues default; add stores delay and priority", async () => {
    const service = await startTestService({ files, env: { QS_QUEUES_CONSUME: "false" } });
    try {
      const add = async (body: unknown) => (await (await service.fetch("/add", post(body))).json()) as { id: string; error?: string };
      expect(await messages(service).findById((await add({ name: "once" })).id)).toMatchObject({ maxAttempts: 2 });
      expect(await messages(service).findById((await add({ name: "usual" })).id)).toMatchObject({ maxAttempts: 4, priority: 0 });
      const before = Date.now();
      const delayed = await messages(service).findById((await add({ name: "usual", options: { delay: "5m", priority: 10 } })).id);
      expect(delayed!.priority).toBe(10);
      expect(delayed!.runAt.getTime()).toBeGreaterThanOrEqual(before + 300_000);
      expect(await messages(service).findById((await add({ name: "usual", options: { runAt: "2026-12-01T09:00:00Z" } })).id)).toMatchObject({ runAt: new Date("2026-12-01T09:00:00Z") });
      expect((await add({ name: "usual", options: { priority: 101 } })).error).toBe("Invalid queue options: priority must be an integer from -100 to 100");
      expect((await add({ name: "usual", options: { delay: "1m", runAt: "2026-12-01T09:00:00Z" } })).error).toBe("Invalid queue options: give delay or runAt, not both");
    } finally {
      await service.stop();
    }
  });
});
