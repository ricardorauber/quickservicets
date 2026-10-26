import { describe, expect, test } from "bun:test";
import { startTestService } from "../testing/service.ts";

const config = (events: string) => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), events: ${events}, sink: {} });
`;
const SINK = `import { defineFeature, type AnyEvent } from "@quickservicets/core";
export default defineFeature({
  key: "sink",
  requires: ["events"],
  setup(ctx) {
    const received = ((globalThis as { delivered?: AnyEvent[] }).delivered = []);
    ctx.events.deliver("audit-sink", { pattern: "user.*", handler: (event) => void received.push(event) });
  },
});
`;
const files = (events: string) => ({
  "quickservicets.config.ts": config(events),
  "entities/User.ts": "export type User = { name: string };\n",
  "features/sink/index.ts": SINK,
});
type Deliveries = { outboxDeliveries: { query(): { all(): Promise<{ status: string; consumer: string; attempt: number }[]> } } };

describe("durable consumers", () => {
  test("a consumer registered in setup receives user.created once, and its row ends delivered", async () => {
    const service = await startTestService({ files: files('{ outbox: true }') });
    try {
      await service.fetch("/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "a" }) });
      const deliveries = (service.repos as unknown as Deliveries).outboxDeliveries;
      for (let attempt = 0; attempt < 400 && (await deliveries.query().all()).some((row) => row.status !== "delivered"); attempt++) await Bun.sleep(10);
      expect(await deliveries.query().all()).toEqual([expect.objectContaining({ consumer: "audit-sink", status: "delivered", attempt: 1 })]);
      const delivered = (globalThis as { delivered?: { type: string }[] }).delivered ?? [];
      expect(delivered.map((event) => event.type)).toEqual(["user.created"]);
    } finally {
      await service.stop();
    }
  });

  test("without the outbox the consumer's setup fails", async () => {
    await expect(startTestService({ files: files("{}") })).rejects.toThrow("audit-sink needs events: { outbox: true }");
  });
});
