import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "@scalar/openapi-parser";
import { definePostHook, definePreHook, resolveRouteHooks } from "@quickservicets/core";
import { crudTable } from "../build/build.ts";
import { scanEndpoints } from "../endpoints/scan-endpoints.ts";
import { parseProjectEntities } from "../entities/parse-entities.ts";
import { parseEndpointTags } from "../hooks/endpoint-tags.ts";
import { scanHooks } from "../hooks/scan-hooks.ts";
import { createLinkedProject } from "../testing/project.ts";
import { describeEndpoints } from "./endpoint-docs.ts";
import { generateOpenApi } from "./generate-openapi.ts";

const hookFiles = {
  "hooks/authorized.ts":
    'import { definePreHook } from "@quickservicets/core";\nexport default definePreHook(() => {}, { docs: { responses: [401, 403], security: "bearer" } });',
  "hooks/audited.ts": 'import { definePreHook } from "@quickservicets/core";\nexport default definePreHook(() => {}, { docs: { responses: [400, 429] } });',
  "hooks/sanitize.ts": 'import { definePostHook } from "@quickservicets/core";\nexport default definePostHook((data) => data);',
};

async function documentFor(files: Record<string, string>) {
  const root = createLinkedProject({ ...hookFiles, ...files });
  const models = parseProjectEntities(root);
  const routes = crudTable(models);
  const hooks = await scanHooks(root);
  const inputs = scanEndpoints(root).map((route) => {
    const tags = parseEndpointTags(readFileSync(join(root, route.file), "utf8"), route.file);
    const generated = routes.find(
      (candidate) => candidate.method === route.method && candidate.path.replace(/\[[^\]]+\]/g, ":") === route.pattern,
    );
    const entity = generated && models.find((model) => model.key === generated.entity)!;
    const resolved = entity
      ? resolveRouteHooks({ kind: "override", entity, operation: generated.operation, endpointHooks: tags.hooks })
      : resolveRouteHooks({ kind: "custom", endpointHooks: tags.hooks });
    return {
      route,
      metadata: tags.metadata,
      hooks: resolved,
      override: generated ? { entity: generated.entity, operation: generated.operation } : undefined,
    };
  });
  const { docs } = describeEndpoints(root, models, inputs);
  const doc = generateOpenApi({ models, routes, hooks, packageJson: { name: "api", version: "1.0.0" }, endpoints: docs });
  return { doc: doc as unknown as { paths: Record<string, Record<string, any>>; components: Record<string, any> }, raw: doc };
}

describe("hook lines and x-hooks", () => {
  test("scoped hooks with arguments appear only on their operation", async () => {
    const { doc } = await documentFor({ "entities/User.ts": "/** @authorized:create admin */\nexport type User = { email: string }" });
    const create = doc.paths["/users"]!.post;
    expect(create.description).toBe("Hooks: authorized(admin)");
    expect(create["x-hooks"]).toEqual([{ name: "authorized", phase: "pre", args: ["admin"] }]);
    expect(doc.paths["/users"]!.get.description).toBeUndefined();
    expect(doc.paths["/users"]!.get).not.toHaveProperty("x-hooks");
  });

  test("unscoped hooks list every hook in execution order, args omitted when empty", async () => {
    const { doc } = await documentFor({ "entities/Post.ts": "/** @audited @sanitize @authorized editor, owner */\nexport type Post = { title: string }" });
    const read = doc.paths["/posts/{id}"]!.get;
    expect(read.description).toBe("Hooks: audited, authorized(editor, owner), sanitize");
    expect(read["x-hooks"]).toEqual([
      { name: "audited", phase: "pre", args: [] },
      { name: "authorized", phase: "pre", args: ["editor", "owner"] },
      { name: "sanitize", phase: "post", args: [] },
    ]);
  });

  test("the line is appended to an endpoint description", async () => {
    const { doc } = await documentFor({ "endpoints/stats/get.ts": "/**\n * @description Counts things.\n * @audited\n */\nexport default () => ({});" });
    expect(doc.paths["/stats"]!.get.description).toBe("Counts things.\n\nHooks: audited");
  });
});

describe("responses and security", () => {
  test("hook responses and bearer security are documented", async () => {
    const { doc, raw } = await documentFor({ "entities/User.ts": "/** @authorized:create admin */\nexport type User = { email: string }" });
    const create = doc.paths["/users"]!.post;
    expect(create.responses["401"]).toEqual({ description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } });
    expect(create.responses["403"].description).toBe("Forbidden");
    expect(create.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.components.securitySchemes).toEqual({ bearerAuth: { type: "http", scheme: "bearer" } });
    expect(doc.paths["/users"]!.get).not.toHaveProperty("security");
    expect((await validate(structuredClone(raw) as unknown as Record<string, unknown>)).errors).toEqual([]);
  });

  test("responses already present are kept as they are", async () => {
    const { doc } = await documentFor({ "entities/Post.ts": "/** @audited:create */\nexport type Post = { title: string }" });
    const create = doc.paths["/posts"]!.post;
    expect(create.responses["400"].description).toBe("Invalid request");
    expect(Object.keys(create.responses)).toEqual(["201", "400", "429"]);
    expect(create).not.toHaveProperty("security");
  });

  test("without bearer hooks there is no security scheme", async () => {
    const { doc } = await documentFor({ "entities/Post.ts": "/** @audited */\nexport type Post = { title: string }" });
    expect(doc.components).not.toHaveProperty("securitySchemes");
  });
});

describe("overrides", () => {
  const user = "/** @authorized */\nexport type User = { email: string }";

  test("an override inherits the entity hooks", async () => {
    const { doc } = await documentFor({ "entities/User.ts": user, "endpoints/users/[id]/get.ts": "/** @sanitize @audited */\nexport default () => ({});" });
    expect(doc.paths["/users/{id}"]!.get["x-hooks"].map((hook: { name: string }) => hook.name)).toEqual(["authorized", "audited", "sanitize"]);
  });

  test("@overrideHooks replace lists only the endpoint's own hooks", async () => {
    const { doc } = await documentFor({
      "entities/User.ts": `/** @authorized @overrideHooks replace */\nexport type User = { email: string }`,
      "endpoints/users/[id]/get.ts": "/** @sanitize */\nexport default () => ({});",
    });
    const read = doc.paths["/users/{id}"]!.get;
    expect(read.description).toBe("Hooks: sanitize");
    expect(read).not.toHaveProperty("security");
  });
});

describe("registry", () => {
  test("definePreHook and definePostHook keep docs options", () => {
    expect(definePreHook(() => {}, { docs: { responses: [401, 403], security: "bearer" } }).docs).toEqual({
      responses: [401, 403],
      security: "bearer",
    });
    expect(definePostHook((data) => data, { docs: { responses: [500] } }).docs).toEqual({ responses: [500] });
    expect(definePreHook(() => {})).not.toHaveProperty("docs");
  });

  test("scanned hooks carry their docs options", async () => {
    const root = createLinkedProject(hookFiles);
    const hooks = await scanHooks(root);
    expect(hooks.get("authorized")).toMatchObject({ phase: "pre", docs: { responses: [401, 403], security: "bearer" } });
    expect(hooks.get("sanitize")).not.toHaveProperty("docs");
  });
});
