import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createApp, definePostHook, projectResult, resolveConfig } from "@quickservice/core";
import { BuildError } from "../errors.ts";
import { parseEndpointTags } from "../hooks/endpoint-tags.ts";
import { scanHooks } from "../hooks/scan-hooks.ts";
import { createLinkedProject, MEMORY_CONFIG } from "../testing/project.ts";
import { build } from "./build.ts";

describe("tags", () => {
  test("@fields and @exclude parse into a projection", () => {
    expect(parseEndpointTags("/** @fields id, name @audit */\nexport default () => {};", "f.ts")).toEqual({
      hooks: [{ name: "audit", args: [] }],
      metadata: { projection: { include: ["id", "name"] } },
    });
    expect(parseEndpointTags("/** @exclude address.zip */\nexport default () => {};", "f.ts").metadata).toEqual({
      projection: { exclude: ["address.zip"] },
    });
  });
  test("both together fail naming the file", () => {
    expect(() => parseEndpointTags("/** @fields a @exclude b */\nexport default () => {};", "endpoints/get.ts")).toThrow("endpoints/get.ts");
  });
  test("fields and exclude are reserved hook names", async () => {
    const root = createLinkedProject({ "hooks/fields.ts": 'import { definePreHook } from "@quickservice/core";\nexport default definePreHook(() => {});' });
    await expect(scanHooks(root)).rejects.toBeInstanceOf(BuildError);
  });
});

test("result shapes", () => {
  const projection = { include: ["id"] };
  expect(projectResult({ id: 1, x: 2 }, projection)).toEqual({ id: 1 });
  expect(projectResult([{ id: 1, x: 2 }], projection)).toEqual([{ id: 1 }]);
  expect(projectResult({ data: [{ id: 1, x: 2 }], total: 1 }, projection)).toEqual({ data: [{ id: 1 }], total: 1 });
  const response = new Response("x");
  expect(projectResult(response, projection)).toBe(response);
  expect(projectResult(undefined, projection)).toBeUndefined();
});

const user = `export type User = {
  email: string;
  name: string;
  /** @hidden:list */ address: { city: string; zip: string };
};`;

async function appFor(endpoints: Record<string, string>) {
  const root = createLinkedProject({
    "quickservice.config.ts": MEMORY_CONFIG,
    "entities/User.ts": user,
    "hooks/spy.ts": 'import { definePostHook } from "@quickservice/core";\nexport const seen = [];\nexport default definePostHook((data) => (seen.push(data), data));',
    ...endpoints,
  });
  await build(root);
  const { models } = await import(join(root, ".generated/models.ts"));
  const { crudRoutes, endpoints: generated, hooks } = await import(join(root, ".generated/routes.ts"));
  const config = resolveConfig({ ...(await import(join(root, "quickservice.config.ts"))).default, logger: { info() {}, warn() {}, error() {} } }, {});
  await config.database.connect(models);
  const { server, repos } = createApp({ models, crudRoutes, endpoints: generated, hooks, config });
  await (repos.users as { create(data: unknown): Promise<unknown> }).create({ email: "a@b.co", name: "Ann", address: { city: "Rio", zip: "1" } });
  const get = async (path: string) => (await server.fetch(new Request(`http://x${path}`))).json();
  return { get, root, seen: (await import(join(root, "hooks/spy.ts"))).seen as unknown[] };
}

test("a custom endpoint projects its result", async () => {
  const { get } = await appFor({ "endpoints/reports/get.ts": '/** @fields id,name */\nexport default () => [{ id: 1, name: "a", total: 9 }];' });
  expect(await get("/reports")).toEqual([{ id: 1, name: "a" }]);
});

test("an override replaces the entity rules for its route", async () => {
  const { get } = await appFor({
    "endpoints/users/get.ts": '/** @exclude address.zip */\nexport default async (repos) => repos.users.list({ where: [], sort: [{ field: "id", direction: "asc" }], limit: 20, offset: 0 });',
  });
  const body = (await get("/users")) as { data: { address: unknown }[] };
  expect(body.data[0]!.address).toEqual({ city: "Rio" });
});

test("an override without tags keeps the entity rules", async () => {
  const { get } = await appFor({
    "endpoints/users/get.ts": 'export default async (repos) => repos.users.list({ where: [], sort: [{ field: "id", direction: "asc" }], limit: 20, offset: 0 });',
  });
  expect(((await get("/users")) as { data: object[] }).data[0]).not.toHaveProperty("address");
});

test("override paths are validated at build time", async () => {
  const root = createLinkedProject({
    "quickservice.config.ts": MEMORY_CONFIG,
    "entities/User.ts": user,
    "endpoints/users/[id]/get.ts": "/** @fields nope */\nexport default () => ({});",
  });
  await expect(build(root)).rejects.toThrow("endpoints/users/[id]/get.ts: unknown path nope");
});

test("post-hooks receive the projected result", async () => {
  const { get, seen } = await appFor({ "endpoints/reports/get.ts": '/** @fields id @spy */\nexport default () => ({ id: 1, secret: 2 });' });
  await get("/reports");
  expect(seen).toEqual([{ id: 1 }]);
});

test("definePostHook import keeps the module typed", () => {
  expect(definePostHook((data) => data).phase).toBe("post");
});
