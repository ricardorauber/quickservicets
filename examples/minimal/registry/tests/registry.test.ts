import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestService } from "@quickservicets/cli/testing";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const files = () => ({ "quickservicets.config.ts": read("quickservicets.config.ts"), "entities/Invoice.ts": read("entities/Invoice.ts") });

test("the instance registers once started, and the registry check is ready", async () => {
  const service = await startTestService({ files: files() });
  try {
    const ready = (await (await service.fetch("/health/ready")).json()) as { checks: Record<string, { status: string }> };
    expect(ready.checks.registry?.status).toBe("ok");
  } finally {
    await service.stop();
  }
});
