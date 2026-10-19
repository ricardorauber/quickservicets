import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp, resolveConfig } from "@quickservice/core";
import { parseEntities } from "../entities/parse-entities.ts";
import { createLinkedProject, MEMORY_CONFIG } from "../testing/project.ts";
import { run } from "../run.ts";
import { build } from "./build.ts";
import { generateEntityType } from "./generate-types.ts";

const preHook = `import { definePreHook } from "@quickservice/core";
export default definePreHook((_, req) => { req.context.audited = true; });
`;

const project = (files: Record<string, string> = {}) =>
  createLinkedProject({
    "quickservice.config.ts": MEMORY_CONFIG,
    "entities/Organization.ts": "export type Organization = { name: string }",
    "entities/User.ts": `import type { Organization } from "./Organization";
/** @audit:create */
export type User = {
  /** @unique */ email: string;
  age?: number;
  active: boolean;
  birth?: Date;
  role: 'admin' | 'member';
  tags: string[];
  address?: { city: string; zip?: string };
  organization?: Organization;
  /** @hidden */ passwordHash: string;
};`,
    "hooks/audit.ts": preHook,
    "endpoints/health/get.ts": "/** @audit */\nexport default () => ({ ok: true });",
    ...files,
  });

const read = (root: string, file: string) => readFileSync(join(root, ".generated", file), "utf8");

test("generated type for each field kind", () => {
  const root = project();
  const user = parseEntities(root).find((model) => model.entityName === "User")!;
  expect(generateEntityType(user)).toBe(`export type User = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  email: string;
  age?: number | null;
  active: boolean;
  birth?: Date | null;
  role: "admin" | "member";
  tags: Array<string>;
  address?: {
    city: string;
    zip?: string | null;
  } | null;
  organization?: string | null;
  passwordHash?: string | null;
};`);
});

test("reference fields are typed as id strings", async () => {
  const root = project();
  await build(root);
  expect(read(root, "types.ts")).toContain("organization?: string | null;");
});

test("builds are deterministic", async () => {
  const root = project();
  await build(root);
  const first = Object.fromEntries(readdirSync(join(root, ".generated")).map((file) => [file, read(root, file)]));
  await build(root);
  const second = Object.fromEntries(readdirSync(join(root, ".generated")).map((file) => [file, read(root, file)]));
  expect(Object.keys(first).sort()).toEqual(["jobs.ts", "models.ts", "openapi.json", "routes.ts", "server.ts", "types.ts"]);
  expect(second).toEqual(first);
});

describe("failures", () => {
  test("keep the previous output and exit 1 naming file and tag", async () => {
    const root = project();
    await build(root);
    const before = read(root, "models.ts");
    writeFileSync(join(root, "entities/Organization.ts"), "/** @nope */\nexport type Organization = { name: string }");
    const errors: string[] = [];
    const code = await run(["build"], { log: () => {}, error: (line) => errors.push(line) }, root);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("entities/Organization.ts: unknown hook @nope");
    expect(read(root, "models.ts")).toBe(before);
    expect(existsSync(join(root, ".generated.staging"))).toBe(false);
  });

  test("stale files are removed on rebuild", async () => {
    const root = project();
    await build(root);
    writeFileSync(join(root, ".generated", "stale.ts"), "");
    await build(root);
    expect(existsSync(join(root, ".generated", "stale.ts"))).toBe(false);
  });
});

test("summary counts", async () => {
  const logs: string[] = [];
  const code = await run(["build"], { log: (line) => logs.push(line), error: () => {} }, project());
  expect(code).toBe(0);
  expect(logs).toEqual(["Built 4 entities, 1 custom endpoints and 1 hooks."]);
});

test("end-to-end build and request through the generated app", async () => {
  const root = project();
  await build(root);
  const { models } = await import(join(root, ".generated/models.ts"));
  const { crudRoutes, endpoints, hooks } = await import(join(root, ".generated/routes.ts"));
  const projectConfig = (await import(join(root, "quickservice.config.ts"))).default;
  const config = resolveConfig(projectConfig, {});
  await config.database.connect(models);
  const { server } = createApp({ models, crudRoutes, endpoints, hooks, config });

  const health = await server.fetch(new Request("http://localhost/health"));
  expect(await health.json()).toEqual({ ok: true });
  const created = await server.fetch(
    new Request("http://localhost/users", {
      method: "POST",
      body: JSON.stringify({ email: "a@b.co", active: true, role: "member", tags: [], passwordHash: "x" }),
    }),
  );
  expect(created.status).toBe(201);
  expect(await created.json()).not.toHaveProperty("passwordHash");
  const listed = (await (await server.fetch(new Request("http://localhost/users"))).json()) as { total: number };
  expect(listed.total).toBe(1);
});
