import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestService } from "@quickservicets/cli/testing";

const root = join(import.meta.dir, "..");
const files = {
  "quickservicets.config.ts": readFileSync(join(root, "quickservicets.config.ts"), "utf8"),
  "endpoints/status/get.ts": readFileSync(join(root, "endpoints/status/get.ts"), "utf8"),
};
const dir = mkdtempSync(join(tmpdir(), "minimal-secrets-"));
writeFileSync(join(dir, "api-key"), "example-api-key-123\n");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a file:// reference in API_KEY resolves at startup", async () => {
  const service = await startTestService({ files, env: { API_KEY: `file://${join(dir, "api-key")}` } });
  try {
    expect(await (await service.fetch("/status")).json()).toEqual({ apiKey: "resolved", length: 19 });
  } finally {
    await service.stop();
  }
});

test("a reference that cannot be resolved stops startup naming it", async () => {
  await expect(startTestService({ files, env: { API_KEY: `file://${join(dir, "missing")}` } })).rejects.toThrow(`env.API_KEY: file://${join(dir, "missing")} (not found)`);
});
