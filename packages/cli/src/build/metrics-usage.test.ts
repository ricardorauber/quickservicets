import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerProjectFeatures } from "@quickservicets/core";
import { addMigration } from "../migrations/add.ts";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService, type TestService } from "../testing/service.ts";

afterEach(() => registerProjectFeatures([]));

const running: TestService[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
});

const state = globalThis as unknown as { usageErrors: string[] };

/** A feature with a usage counter: endpoints and jobs add to it through the recorder it keeps. */
const FEATURE = `import { defineFeature } from "@quickservicets/core";
const state = globalThis as unknown as { items?: { add(value: number, dimensions?: object): void }; usageErrors: string[] };
export default defineFeature({
  key: "counting",
  requires: ["metrics"],
  setup(ctx) {
    state.items = ctx.feature("metrics").usage("test.items", { unit: "items", description: "Items handled" });
    for (const attempt of [() => ctx.feature("metrics").usage("test.items", { unit: "items", description: "again" }), () => ctx.feature("metrics").usage("Test.Items", { unit: "x", description: "x" }), () => state.items!.add(-1), () => state.items!.add(Number.NaN)]) {
      try {
        attempt();
      } catch (error) {
        state.usageErrors.push((error as Error).message);
      }
    }
  },
});
`;
const FILES = {
  "features/counting/index.ts": FEATURE,
  "entities/Post.ts": "export type Post = { title: string };\n",
  "endpoints/posts/get.ts": `const state = globalThis as unknown as { items: { add(value: number): void } };
export default () => {
  state.items.add(3);
  return { data: [] };
};
`,
  "endpoints/notes/get.ts": `const state = globalThis as unknown as { items: { add(value: number): void } };
export default () => {
  state.items.add(10);
  return { data: [] };
};
`,
  "jobs/count.ts": `import { job } from "@quickservicets/core";
const state = globalThis as unknown as { items: { add(value: number): void } };
export default job({ every: "1h" }, () => state.items.add(4));
`,
  "endpoints/run-count/post.ts": 'import type { ServiceRequest } from "@quickservicets/core";\nexport default async (_repos: unknown, req: ServiceRequest) => req.jobs.run("count");\n',
};

async function start(metrics = "{}", tenancy = true) {
  state.usageErrors = [];
  const service = await startTestService({
    files: {
      "quickservicets.config.ts": `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), metrics: ${metrics}, counting: {}, ${tenancy ? 'tenancy: { source: "config", tenants: { acme: {}, globex: {} } },' : ""} logger: { info() {}, warn() {}, error() {} } });
`,
      ...FILES,
    },
  });
  running.push(service);
  return service;
}
const LOCAL = { peer: "127.0.0.1" };
type Body = { totals: { requests: number; usage?: Record<string, number> }; series: { route?: string; tenant?: string; usage?: Record<string, number> }[] };

describe("usage counters", () => {
  test("a value added in a request shows in the totals and in its route and tenant series", async () => {
    const service = await start();
    await service.fetch("/posts", { headers: { "x-tenant-id": "acme" } });
    const body = (await (await service.fetch("/_metrics", LOCAL)).json()) as Body;
    expect(body.totals.usage).toEqual({ "test.items": 3 });
    expect(body.series.find((series) => series.route === "GET /posts" && series.tenant === "acme")).toMatchObject({ usage: { "test.items": 3 } });
  });

  test("a name registered twice, an invalid name and negative or NaN values are refused", async () => {
    await start();
    expect(state.usageErrors).toEqual([
      "Usage metric test.items is registered twice",
      "Invalid usage metric name Test.Items: expected lowercase segments separated by dots, like ai.tokens.input",
      "Usage values must be finite and not negative",
      "Usage values must be finite and not negative",
    ]);
  });

  test("a job adds under route -, and with by: [route] the tenant is dropped", async () => {
    const service = await start('{ by: ["route"] }');
    await service.fetch("/run-count", { method: "POST", headers: { "x-tenant-id": "acme" } });
    await Bun.sleep(50);
    await service.fetch("/posts", { headers: { "x-tenant-id": "acme" } });
    const body = (await (await service.fetch("/_metrics", LOCAL)).json()) as Body;
    expect(body.series.find((series) => series.route === "-")).toMatchObject({ usage: { "test.items": 4 } });
    const posts = body.series.find((series) => series.route === "GET /posts")!;
    expect(posts).not.toHaveProperty("tenant");
    expect(posts.usage).toEqual({ "test.items": 3 });
  });

  test("sort=usage:<name> orders series by the sum, and the Prometheus form has the usage counter", async () => {
    const service = await start();
    for (let index = 0; index < 3; index++) await service.fetch("/posts", { headers: { "x-tenant-id": "acme" } });
    await service.fetch("/notes", { headers: { "x-tenant-id": "acme" } });
    const sorted = (await (await service.fetch("/_metrics?sort=usage:test.items", LOCAL)).json()) as Body;
    expect(sorted.series.map((series) => series.route)).toEqual(["GET /notes", "GET /posts"]);
    const byRequests = (await (await service.fetch("/_metrics?sort=requests", LOCAL)).json()) as Body;
    expect(byRequests.series[0]!.route).toBe("GET /posts");
    expect((await service.fetch("/_metrics?sort=usage:Bad", LOCAL)).status).toBe(400);
    const text = await (await service.fetch("/_metrics?format=prometheus", LOCAL)).text();
    expect(text).toContain("# HELP quickservicets_usage_test_items_total Items handled (items)");
    expect(text).toContain("# TYPE quickservicets_usage_test_items_total counter");
    expect(text).toContain('quickservicets_usage_test_items_total{route="GET /posts",tenant="acme"} 9');
  });

  test("migration add adds the usage column of metric_windows with the database store", async () => {
    const root = createLinkedProject({
      "quickservicets.config.ts": `import { defineConfig, sqliteAdapter } from "@quickservicets/core";\nexport default defineConfig({ database: sqliteAdapter({ path: ":memory:" }), metrics: { store: "database" } });\n`,
    });
    const created = readFileSync(join(root, (await addMigration(root, "Initial", new Date(Date.UTC(2026, 0, 1)))).file), "utf8");
    expect(created).toMatch(/metric_windows[\s\S]*`usage` text/);
  });
});
