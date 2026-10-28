import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { MetricsApi } from "@quickservicets/core";
import { startTestService } from "@quickservicets/cli/testing";

const root = join(import.meta.dir, "..");

/** The example's own files, as `startTestService` takes them. */
function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = { "quickservicets.config.ts": readFileSync(join(root, "quickservicets.config.ts"), "utf8") };
  for (const entry of readdirSync(join(root, "endpoints"), { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files[relative(root, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), "utf8");
  }
  return files;
}

/** A project feature handing the metrics API to the test once the service started. */
const PROBE = `import { defineFeature } from "@quickservicets/core";
export default defineFeature({
  key: "probe",
  enabledByDefault: true,
  requires: ["metrics"],
  setup(ctx) {
    ctx.app.onStart(() => void ((globalThis as any).usage = ctx.feature("metrics")));
  },
});
`;

test("requests and errors are counted per route with their latency", async () => {
  const service = await startTestService({ files: { ...exampleFiles(), "features/probe/index.ts": PROBE } });
  try {
    for (let i = 0; i < 5; i++) await service.fetch(i === 0 ? "/posts?fail=1" : "/posts");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await (globalThis as { usage?: MetricsApi }).usage!.query({ last: "5m" });
    expect(result.series[0]).toMatchObject({ route: "GET /posts", tenant: "-", requests: 5, errors: 1 });
    expect(result.series[0]!.p99).toBeGreaterThan(0);
  } finally {
    await service.stop();
  }
});
