import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addMigration } from "../migrations/add.ts";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";

const config = (adapter = "memoryAdapter()") => `import { defineConfig, memoryAdapter, sqliteAdapter, postgresAdapter } from "@quickservicets/core";
const logs = ((globalThis as { tenancyLogs?: unknown[] }).tenancyLogs ??= []);
export default defineConfig({ database: ${adapter}, tenancy: {}, logger: { info: (entry) => void logs.push(entry), warn: (entry) => void logs.push(entry), error: (entry) => void logs.push(entry) } });
`;
const FILES = {
  "quickservicets.config.ts": config(),
  "entities/Post.ts": "export type Post = { title: string };\n",
  "endpoints/whoami/get.ts": 'import type { Repositories, ServiceRequest } from "@quickservicets/core";\nexport default (_repos: Repositories, req: ServiceRequest) => ({ tenant: req.tenant });\n',
};

describe("the Tenant table of the database source", () => {
  for (const [name, adapter] of Object.entries({ sqlite: 'sqliteAdapter({ path: ":memory:" })', postgres: 'postgresAdapter({ url: "postgres://localhost/none" })' })) {
    test(`${name}: migration add creates tenants`, async () => {
      const root = createLinkedProject({ ...FILES, "quickservicets.config.ts": config(adapter) });
      const created = readFileSync(join(root, (await addMigration(root, "Tenants", new Date(Date.UTC(2026, 0, 1)))).file), "utf8");
      expect(created).toMatch(/CREATE TABLE \\?[`"](\{\{default_schema\}\})?tenants/);
    });
  }

  test("it has no routes; a row makes its tenant resolve, a change of plan applies at the next request, and the connection never shows", async () => {
    const service = await startTestService({ files: FILES });
    const logs = ((globalThis as { tenancyLogs?: unknown[] }).tenancyLogs ??= []);
    logs.length = 0;
    try {
      const tenants = (service.repos as unknown as Record<string, unknown>).tenants as { create(data: unknown): Promise<{ id: string }>; update(id: string, data: unknown): Promise<unknown> };
      const listed = await service.fetch("/tenants", { headers: { "x-tenant-id": "acme" } });
      expect(listed.status).toBe(404);
      const unknown = await service.fetch("/whoami", { headers: { "x-tenant-id": "acme" } });
      expect([unknown.status, ((await unknown.json()) as { error: { message: string } }).error.message]).toEqual([404, "Tenant not found"]);
      // The unknown id is cached for negativeTtl, but a local write refreshes this worker's entry at once.
      const row = await tenants.create({ key: "acme", plan: "free", connection: "postgres://app:s3cret@db/acme", attributes: { region: "eu" } });
      expect(await (await service.fetch("/whoami", { headers: { "x-tenant-id": "acme" } })).json()).toEqual({ tenant: { id: "acme", plan: "free", attributes: { region: "eu" } } });
      await tenants.update(row.id, { plan: "pro" });
      expect(await (await service.fetch("/whoami", { headers: { "x-tenant-id": "acme" } })).json()).toEqual({ tenant: { id: "acme", plan: "pro", attributes: { region: "eu" } } });
      await tenants.update(row.id, { status: "suspended" });
      const suspended = await service.fetch("/whoami", { headers: { "x-tenant-id": "acme" } });
      expect([suspended.status, ((await suspended.json()) as { error: { message: string } }).error.message]).toEqual([403, "Tenant is suspended"]);
      expect(JSON.stringify(logs)).not.toContain("s3cret");
      const invalid = await tenants.create({ key: "Not Valid" }).then(() => undefined, (error: { status: number }) => error.status);
      expect(invalid).toBe(400);
    } finally {
      await service.stop();
    }
  });
});
