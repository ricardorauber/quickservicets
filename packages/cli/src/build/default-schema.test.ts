import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp, loadConfig } from "@quickservice/core";
import { createLinkedProject } from "../testing/project.ts";
import { build } from "./build.ts";

test("generated output never contains the default schema, and the app works with any value", async () => {
  const root = createLinkedProject({
    "quickservice.config.ts":
      'import { defineConfig, memoryAdapter } from "@quickservice/core";\nexport default defineConfig({ database: memoryAdapter(), schema: "app" });\n',
    "entities/User.ts": "export type User = { email: string }",
  });
  const snapshotOf = () =>
    Object.fromEntries(readdirSync(join(root, ".generated")).map((file) => [file, readFileSync(join(root, ".generated", file), "utf8")]));

  process.env.DATABASE_SCHEMA = "tenant-a";
  await build(root);
  const first = snapshotOf();
  process.env.DATABASE_SCHEMA = "tenant-b";
  await build(root);
  delete process.env.DATABASE_SCHEMA;
  expect(snapshotOf()).toEqual(first);
  expect(JSON.stringify(first)).not.toMatch(/tenant-|"app"/);

  const { models } = await import(join(root, ".generated/models.ts"));
  const { crudRoutes, endpoints, hooks } = await import(join(root, ".generated/routes.ts"));
  for (const schema of ["tenant-a", "tenant-b"]) {
    const config = await loadConfig(root, { DATABASE_SCHEMA: schema });
    expect(config.schema).toBe(schema);
    await config.database.connect(models);
    const { server } = createApp({ models, crudRoutes, endpoints, hooks, config: { ...config, logger: { info() {}, warn() {}, error() {} } } });
    expect((await server.fetch(new Request("http://localhost/users"))).status).toBe(200);
  }
});
