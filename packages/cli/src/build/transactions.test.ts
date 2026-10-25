import { describe, expect, test } from "bun:test";
import { startTestService } from "../testing/service.ts";
import { createLinkedProject, MEMORY_CONFIG } from "../testing/project.ts";
import { build } from "./build.ts";

const CONFIG = `import { defineConfig, memoryAdapter } from "@quickservice/core";
export default defineConfig({ database: memoryAdapter(), stocker: {} });
`;

const files = {
  "quickservice.config.ts": CONFIG,
  "entities/Order.ts": "export type Order = { item: string };\n",
  "entities/Stock.ts": "export type Stock = { count: number };\n",
  "jobs/restock.ts": `import { job } from "@quickservice/core";
export default job({ every: "1h" }, async ({ repos }) => {
  await repos.transaction(async () => {
    await repos.orders.create({ item: "from job" });
    await repos.stocks.create({ count: 10 });
  });
});
`,
  "endpoints/restock/post.ts": `import type { Endpoint } from "@quickservice/core";
const handler: Endpoint = async (_repos, req) => req.jobs.run("restock");
export default handler;
`,
  "features/stocker/index.ts": `import { defineFeature, transaction } from "@quickservice/core";
export default defineFeature({
  key: "stocker",
  setup(ctx) {
    ctx.app.onStart(async ({ repos }) => {
      await transaction(async () => {
        await repos.orders.create({ item: "from feature" });
        await repos.stocks.create({ count: 1 });
      });
    });
  },
});
`,
};

describe("transactions from jobs and features", () => {
  test("a job's repos.transaction and a feature's transaction commit both writes", async () => {
    const service = await startTestService({ files });
    try {
      const repos = service.repos as unknown as Record<string, { query(): { all(): Promise<Record<string, unknown>[]> } }>;
      expect((await repos.orders!.query().all()).map((order) => order.item)).toEqual(["from feature"]);
      expect((await service.fetch("/restock", { method: "POST" })).status).toBe(200);
      for (let attempt = 0; attempt < 100 && (await repos.orders!.query().all()).length < 2; attempt++) await Bun.sleep(10);
      expect((await repos.orders!.query().all()).map((order) => order.item).sort()).toEqual(["from feature", "from job"]);
      expect((await repos.stocks!.query().all()).map((stock) => stock.count).sort()).toEqual([1, 10]);
    } finally {
      await service.stop();
    }
  });
});

describe("the reserved repository key", () => {
  test("an entity whose repository key is transaction fails the build", async () => {
    const root = createLinkedProject({ "quickservice.config.ts": MEMORY_CONFIG, "entities/Payment.ts": "/** @collection transaction */\nexport type Payment = { amount: number };\n" });
    let message = "";
    try {
      await build(root);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("entities/Payment.ts: the repository key transaction is reserved; rename the entity or set @collection");
  });

  test("the generated Repositories type repos.transaction", async () => {
    const root = createLinkedProject({ "quickservice.config.ts": MEMORY_CONFIG, "entities/Payment.ts": "export type Payment = { amount: number };\n" });
    await build(root);
    expect(await Bun.file(`${root}/.generated/types.ts`).text()).toContain("  transaction<T>(fn: () => Promise<T>): Promise<T>;");
  });
});
