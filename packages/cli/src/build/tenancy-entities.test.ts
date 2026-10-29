import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EntityModel } from "@quickservicets/core";
import { createLinkedProject } from "../testing/project.ts";
import { build } from "./build.ts";

const config = (keys: string) => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), ${keys}, logger: { info() {}, warn() {}, error() {} } });
`;
const TENANCY = 'tenancy: { source: "config", tenants: { acme: {} } }, events: {}, history: {}';
const FILES = {
  "entities/Post.ts": "/** @history */\nexport type Post = { title: string };\n",
  "entities/auth/User.ts": "export type User = { email: string };\n",
  "entities/Plan.ts": "/** @tenancy shared */\nexport type Plan = { name: string };\n",
  "jobs/report.ts": 'import { job } from "@quickservicets/core";\nexport default job({ every: "1h" }, async () => {});\n',
};

async function builtModels(files: Record<string, string>): Promise<{ root: string; models: EntityModel[]; text: string }> {
  const root = createLinkedProject(files);
  await build(root, {});
  const text = readFileSync(join(root, ".generated/models.ts"), "utf8");
  const models = JSON.parse(text.slice(text.indexOf("= ") + 2, text.lastIndexOf(";"))) as EntityModel[];
  return { root, models, text };
}
const failure = async (files: Record<string, string>) => {
  const root = createLinkedProject(files);
  return build(root, {}).then(() => "built", (error: Error) => error.message);
};

describe("tenant and shared entities", () => {
  test("the build marks each model: tenant data, explicit schemas, tagged entities, system entities and derived models", async () => {
    // Post references Media, so the built-in file entity is in the model and marked too.
    const withMedia = { ...FILES, "entities/Post.ts": 'import type { Media } from "@quickservicets/core";\n/** @history */\nexport type Post = { title: string; cover?: Media };\n' };
    const { models } = await builtModels({ ...withMedia, "quickservicets.config.ts": config(TENANCY) });
    const tenancy = Object.fromEntries(models.map((model) => [model.key, model.tenancy]));
    expect(tenancy).toMatchObject({ Post: "tenant", "auth/User": "shared", Plan: "shared", JobRun: "shared", PostHistory: "tenant", Media: "tenant" });
    const withDatabase = await builtModels({ ...FILES, "quickservicets.config.ts": config("tenancy: {}, events: {}, history: {}") });
    expect(withDatabase.models.find((model) => model.key === "Tenant")?.tenancy).toBe("shared");
  });

  test("without tenancy the generated models carry no marks", async () => {
    const { text } = await builtModels({ ...FILES, "entities/Plan.ts": "export type Plan = { name: string };\n", "quickservicets.config.ts": config("events: {}, history: {}") });
    expect(text).not.toContain('"tenancy"');
    expect(text).not.toContain('"derivedFrom"');
  });

  test("references between tenant and shared entities fail the build, both ways", async () => {
    const base = { "quickservicets.config.ts": config(TENANCY), "entities/Plan.ts": "/** @tenancy shared */\nexport type Plan = { name: string };\n" };
    expect(await failure({ ...base, "entities/Post.ts": 'import type { Plan } from "./Plan";\nexport type Post = { title: string; plan: Plan };\n' })).toBe(
      "entities/Post.ts: Post holds tenant data and cannot reference Plan, which is shared; store its id in a string field",
    );
    expect(
      await failure({
        ...base,
        "entities/Post.ts": "export type Post = { title: string };\n",
        "entities/Plan.ts": 'import type { Post } from "./Post";\n/** @tenancy shared */\nexport type Plan = { name: string; posts: Post[] };\n',
      }),
    ).toBe("entities/Plan.ts: Plan is shared and cannot reference Post, which holds tenant data; store its id in a string field");
  });

  test("@tenancy shared on an endpoint and required=false on an entity fail; the OpenAPI document marks tenant operations", async () => {
    const tenancy = { "quickservicets.config.ts": config(TENANCY), "entities/Post.ts": FILES["entities/Post.ts"] };
    expect(await failure({ ...tenancy, "endpoints/ping/get.ts": "/** @tenancy shared */\nexport default () => ({ ok: true });\n" })).toBe(
      "endpoints/ping/get.ts: invalid @tenancy: scope applies only to entities",
    );
    expect(await failure({ ...tenancy, "entities/Post.ts": "/** @tenancy required=false */\nexport type Post = { title: string };\n" })).toBe(
      "entities/Post.ts: invalid @tenancy: required applies only to endpoints",
    );
    const { root } = await builtModels({ ...FILES, "quickservicets.config.ts": config(TENANCY) });
    const doc = JSON.parse(readFileSync(join(root, ".generated/openapi.json"), "utf8")) as { paths: Record<string, Record<string, { "x-tenant"?: string; parameters?: { name: string; in: string }[] }>> };
    expect(doc.paths["/posts"]!.get!["x-tenant"]).toBe("required");
    expect(doc.paths["/posts"]!.get!.parameters).toContainEqual(expect.objectContaining({ name: "x-tenant-id", in: "header" }));
    expect(doc.paths["/plans"]!.get!["x-tenant"]).toBeUndefined();
  });
});
