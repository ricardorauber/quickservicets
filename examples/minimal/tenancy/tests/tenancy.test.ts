import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { startTestService } from "@quickservicets/cli/testing";

const root = join(import.meta.dir, "..");

/** The example's own files, as `startTestService` takes them. */
function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = { "quickservicets.config.ts": readFileSync(join(root, "quickservicets.config.ts"), "utf8") };
  for (const folder of ["entities", "endpoints"]) {
    for (const entry of readdirSync(join(root, folder), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files[relative(root, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), "utf8");
    }
  }
  return files;
}

test("each request is resolved to the tenant of its x-tenant-id header", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    expect(await (await service.fetch("/whoami", { headers: { "x-tenant-id": "acme" } })).json()).toEqual({ tenant: "acme" });
    const missing = await service.fetch("/whoami");
    expect([missing.status, ((await missing.json()) as { error: { code: string } }).error.code]).toEqual([400, "TENANT_REQUIRED"]);
    const invalid = await service.fetch("/whoami", { headers: { "x-tenant-id": "ACME" } });
    expect([invalid.status, ((await invalid.json()) as { error: { code: string } }).error.code]).toEqual([400, "INVALID_TENANT"]);
  } finally {
    await service.stop();
  }
});

test("an endpoint tagged @tenancy off answers without a tenant", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    expect(await (await service.fetch("/status")).json()).toEqual({ status: "ok" });
  } finally {
    await service.stop();
  }
});
