import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "@scalar/openapi-parser";
import { addOperation, addSchema, addSecurityScheme, defineFeature, registerNative, registerProjectFeatures, type OpenApiDoc } from "@quickservicets/core";
import { unregisterNative } from "../../../core/src/features.ts";
import { build } from "../build/build.ts";
import { createLinkedProject } from "../testing/project.ts";

const config = (keys = "", docs = "") => `import { defineConfig, memoryAdapter, requireSecurity } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter()${keys ? `, ${keys}` : ""}${docs ? `, docs: { ${docs} }` : ""} });
`;
const project = (keys = "", docs = "", files: Record<string, string> = {}) =>
  createLinkedProject({ "quickservicets.config.ts": config(keys, docs), "entities/User.ts": "export type User = { email: string };\n", ...files });
const documentOf = (root: string) => JSON.parse(readFileSync(join(root, ".generated/openapi.json"), "utf8")) as OpenApiDoc;
const failure = async (work: () => Promise<unknown>): Promise<Error> => {
  try {
    await work();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure");
};

const registered: string[] = [];
const native = (key: string, openapi: (doc: OpenApiDoc) => OpenApiDoc | void) => {
  registerNative(defineFeature({ docs: { summary: "Test native." }, key, openapi }));
  registered.push(key);
};
afterEach(() => {
  for (const key of registered.splice(0)) unregisterNative(key);
  registerProjectFeatures([]);
});

describe("feature and project functions", () => {
  test("a native adds a security scheme and an operation, and the document stays valid", async () => {
    native("example", (doc) => {
      addSecurityScheme(doc, "exampleKey", { type: "apiKey", in: "header", name: "x-example-key" });
      addOperation(doc, "get", "/example/status", { summary: "Example status", responses: { "200": { description: "The status" } } });
    });
    const root = project("example: {}");
    await build(root);
    const doc = documentOf(root);
    expect(doc.components!.securitySchemes!.exampleKey).toEqual({ type: "apiKey", in: "header", name: "x-example-key" });
    expect((doc.paths["/example/status"]!.get as { summary: string }).summary).toBe("Example status");
    const result = await validate(structuredClone(doc) as unknown as Record<string, unknown>);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("oauth2 and OpenID Connect schemes are written as given; a flow without tokenUrl fails naming it", async () => {
    const flows = { authorizationCode: { authorizationUrl: "https://id.example.com/authorize", tokenUrl: "https://id.example.com/token", scopes: { read: "Read" } } };
    native("auth", (doc) => {
      addSecurityScheme(doc, "oauth", { type: "oauth2", flows });
      addSecurityScheme(doc, "oidc", { type: "openIdConnect", openIdConnectUrl: "https://id.example.com/.well-known/openid-configuration" });
    });
    const root = project("auth: {}");
    await build(root);
    expect(documentOf(root).components!.securitySchemes).toMatchObject({
      oauth: { type: "oauth2", flows },
      oidc: { type: "openIdConnect", openIdConnectUrl: "https://id.example.com/.well-known/openid-configuration" },
    });
    expect((await validate(structuredClone(documentOf(root)) as unknown as Record<string, unknown>)).valid).toBe(true);
    native("broken", (doc) => void addSecurityScheme(doc, "machines", { type: "oauth2", flows: { clientCredentials: { scopes: {} } } } as never));
    expect((await failure(() => build(project("broken: {}")))).message).toBe("broken: openapi: Security scheme machines: flows.clientCredentials.tokenUrl is required");
  });

  test("requireSecurity in the project's function marks GET operations only", async () => {
    native("auth", (doc) => void addSecurityScheme(doc, "oidc", { type: "openIdConnect", openIdConnectUrl: "https://id.example.com/.well-known/openid-configuration" }));
    const root = project("auth: {}", 'openapi: (doc) => requireSecurity(doc, "oidc", { scopes: ["read"], operations: (method) => method === "get" })');
    await build(root);
    const paths = documentOf(root).paths as Record<string, Record<string, { security?: unknown }>>;
    expect(paths["/users"]!.get!.security).toEqual([{ oidc: ["read"] }]);
    expect(paths["/users/{id}"]!.get!.security).toEqual([{ oidc: ["read"] }]);
    expect(paths["/users"]!.post!.security).toBeUndefined();
    expect((await failure(() => build(project("", 'openapi: (doc) => requireSecurity(doc, "nope")')))).message).toBe(
      "docs.openapi: Security scheme nope is not defined; add it with addSecurityScheme first",
    );
  });

  test("duplicates and invalid results fail; the project's function runs after every feature's and sees their changes", async () => {
    native("dup", (doc) => void addSchema(doc, "User", {}));
    expect((await failure(() => build(project("dup: {}")))).message).toBe("dup: openapi: Schema User already exists");
    native("empty", () => ({}) as OpenApiDoc);
    expect((await failure(() => build(project("empty: {}")))).message).toBe("empty: openapi: openapi must be a 3.1 version");
    native("first", (doc) => void addSchema(doc, "Status", { type: "object" }));
    native("second", (doc) => ({ ...doc, info: { ...doc.info, title: `${doc.info.title} (extended)` } }));
    const root = project("first: {}, second: {}", 'openapi: (doc) => { doc.info.description = Object.keys(doc.components.schemas).includes("Status") ? "saw Status" : "no Status"; }');
    await build(root);
    expect(documentOf(root).info).toMatchObject({ description: "saw Status" });
    expect(documentOf(root).info.title).toEndWith("(extended)");
    expect((await failure(() => build(project("", "openapi: () => { throw new Error('no'); }")))).message).toBe("docs.openapi: no");
  });
});

describe("unchanged projects", () => {
  test("without functions the document is the generated one, bearerAuth included", async () => {
    const hook = 'import { definePreHook } from "@quickservicets/core";\nexport default definePreHook(() => {}, { docs: { security: "bearer", responses: [401] } });\n';
    const root = project("", "", { "hooks/auth.ts": hook, "entities/User.ts": "/** @auth */\nexport type User = { email: string };\n" });
    await build(root);
    const doc = documentOf(root);
    expect(doc.components!.securitySchemes).toEqual({ bearerAuth: { type: "http", scheme: "bearer" } });
    const kept = project("", "openapi: (doc) => doc", { "hooks/auth.ts": hook, "entities/User.ts": "/** @auth */\nexport type User = { email: string };\n" });
    await build(kept);
    expect(documentOf(kept)).toEqual(doc);
  });
});
