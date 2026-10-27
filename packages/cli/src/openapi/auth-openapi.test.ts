import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "@scalar/openapi-parser";
import { NO_AUTH_SCHEME_WARNING, registerProjectFeatures, type OpenApiDoc } from "@quickservicets/core";
import { build } from "../build/build.ts";
import { createLinkedProject } from "../testing/project.ts";

const config = (keys: string) => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), ${keys} });
`;

/** A project feature that registers testAuth() and documents an OpenID Connect scheme, and an API key with `apiKey`. */
const providerFeature = (apiKey: boolean) => `import { addAuthScheme, defineFeature } from "@quickservicets/core";
import { testAuth } from "@quickservicets/core/testing";
export default defineFeature({
  key: "sso",
  enabledByDefault: true,
  requires: ["auth"],
  setup: (ctx) => ctx.feature("auth").provider(testAuth()),
  openapi(doc) {
    addAuthScheme(doc, "oidc", { type: "openIdConnect", openIdConnectUrl: "https://id.example.com/.well-known/openid-configuration" });
    ${apiKey ? 'addAuthScheme(doc, "apiKey", { type: "apiKey", in: "header", name: "x-api-key" });' : ""}
    return doc;
  },
});
`;

const ENTITIES = {
  "entities/Post.ts": "/** @auth */\nexport type Post = { title: string };\n",
  "entities/User.ts": "/** @roles admin:delete */\nexport type User = { name: string };\n",
  "endpoints/publish/post.ts": 'import type { Endpoint } from "@quickservicets/core";\n/** @auth scopes=posts:write */\nconst handler: Endpoint = () => ({ ok: true });\nexport default handler;\n',
};

afterEach(() => registerProjectFeatures([]));

async function documentOf(keys: string, files: Record<string, string> = {}) {
  const root = createLinkedProject({ "quickservicets.config.ts": config(keys), ...ENTITIES, ...files });
  const summary = await build(root);
  return { doc: JSON.parse(readFileSync(join(root, ".generated/openapi.json"), "utf8")) as OpenApiDoc, warnings: summary.warnings };
}

const operation = (doc: OpenApiDoc, path: string, method: string) => doc.paths[path]![method] as Record<string, any>;

describe("operation marks", () => {
  test("operations needing a user get x-auth with their roles, others security: [], and bearerAuth is gone", async () => {
    const { doc, warnings } = await documentOf("auth: {}");
    expect(operation(doc, "/posts", "get")["x-auth"]).toEqual({});
    expect(operation(doc, "/users/{id}", "delete")["x-auth"]).toEqual({ roles: ["admin"] });
    expect(operation(doc, "/users", "get").security).toEqual([]);
    expect(operation(doc, "/users", "get")["x-auth"]).toBeUndefined();
    expect(doc.components?.securitySchemes?.bearerAuth).toBeUndefined();
    expect(warnings).toContain(NO_AUTH_SCHEME_WARNING);
    expect((await validate(structuredClone(doc) as unknown as Record<string, unknown>)).valid).toBe(true);
  });

  test("401 and 403 responses and the role and scope notes", async () => {
    const { doc } = await documentOf("auth: {}");
    const remove = operation(doc, "/users/{id}", "delete");
    expect(Object.keys(remove.responses)).toEqual(expect.arrayContaining(["401", "403"]));
    expect(remove.responses["401"]).toEqual({ description: "Authentication required, or Invalid credentials", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } });
    expect(remove.description.endsWith("Requires one of the roles: admin.")).toBe(true);
    const list = operation(doc, "/posts", "get");
    expect(list.responses["401"]).toBeDefined();
    expect(list.responses["403"]).toBeUndefined();
    expect(operation(doc, "/publish", "post").description.endsWith("Requires the scopes: posts:write.")).toBe(true);
  });

  test("required marks every operation but the public ones", async () => {
    const { doc } = await documentOf("auth: { required: true }, health: {}", {
      "endpoints/signup/post.ts": 'import type { Endpoint } from "@quickservicets/core";\n/** @auth off */\nconst handler: Endpoint = () => ({ ok: true });\nexport default handler;\n',
    });
    expect(operation(doc, "/users", "get")["x-auth"]).toEqual({});
    expect(operation(doc, "/signup", "post").security).toEqual([]);
  });
});

describe("addAuthScheme", () => {
  test("a provider's scheme is required on every marked operation, with the operation's scopes for OpenID Connect", async () => {
    const { doc, warnings } = await documentOf("auth: {}", { "features/sso/index.ts": providerFeature(false) });
    expect(operation(doc, "/posts", "get").security).toEqual([{ oidc: [] }]);
    expect(operation(doc, "/users", "get").security).toEqual([]);
    expect(operation(doc, "/publish", "post").security).toEqual([{ oidc: ["posts:write"] }]);
    expect(warnings).not.toContain(NO_AUTH_SCHEME_WARNING);
    expect((await validate(structuredClone(doc) as unknown as Record<string, unknown>)).valid).toBe(true);
  });

  test("a second scheme adds a second alternative, without scopes for an API key", async () => {
    const { doc } = await documentOf("auth: {}", { "features/sso/index.ts": providerFeature(true) });
    expect(operation(doc, "/posts", "get").security).toEqual([{ oidc: [] }, { apiKey: [] }]);
    expect(operation(doc, "/publish", "post").security).toEqual([{ oidc: ["posts:write"] }, { apiKey: [] }]);
  });
});

describe("without auth", () => {
  test("the document is unchanged and keeps bearerAuth from the hooks", async () => {
    const hook = 'import { definePreHook } from "@quickservicets/core";\nexport default definePreHook(() => {}, { docs: { security: "bearer" } });\n';
    const root = createLinkedProject({
      "quickservicets.config.ts": config("docs: {}"),
      "entities/Post.ts": "/** @signedIn */\nexport type Post = { title: string };\n",
      "hooks/signedIn.ts": hook,
    });
    const summary = await build(root);
    const doc = JSON.parse(readFileSync(join(root, ".generated/openapi.json"), "utf8")) as OpenApiDoc;
    expect(doc.components?.securitySchemes).toEqual({ bearerAuth: { type: "http", scheme: "bearer" } });
    expect(operation(doc, "/posts", "get")["x-auth"]).toBeUndefined();
    expect(operation(doc, "/posts", "get").security).toEqual([{ bearerAuth: [] }]);
    expect(summary.warnings).not.toContain(NO_AUTH_SCHEME_WARNING);
  });
});
