import { describe, expect, test } from "bun:test";
import { addOperation, addSchema, addSecurityScheme, requireSecurity, type OpenApiDoc } from "./openapi.ts";

const documentOf = (): OpenApiDoc => ({
  openapi: "3.1.0",
  info: { title: "test", version: "1.0.0" },
  paths: {
    "/users": { get: { responses: {} }, post: { responses: {} } },
    "/users/{id}": { get: { responses: {} }, delete: { responses: {}, security: [{ bearerAuth: [] }] } },
  },
  components: { schemas: { User: { type: "object" } }, securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
});

describe("security schemes", () => {
  test("every scheme type is written as given", () => {
    const doc = documentOf();
    addSecurityScheme(doc, "jwt", { type: "http", scheme: "bearer", bearerFormat: "JWT" });
    addSecurityScheme(doc, "basic", { type: "http", scheme: "basic" });
    addSecurityScheme(doc, "exampleKey", { type: "apiKey", in: "header", name: "x-example-key" });
    const oauth = {
      type: "oauth2" as const,
      flows: {
        authorizationCode: { authorizationUrl: "https://id.example.com/authorize", tokenUrl: "https://id.example.com/token", scopes: { read: "Read data" } },
        clientCredentials: { tokenUrl: "https://id.example.com/token", scopes: {} },
        password: { tokenUrl: "https://id.example.com/token", scopes: {} },
        implicit: { authorizationUrl: "https://id.example.com/authorize", scopes: {} },
      },
    };
    addSecurityScheme(doc, "oauth", oauth);
    addSecurityScheme(doc, "oidc", { type: "openIdConnect", openIdConnectUrl: "https://id.example.com/.well-known/openid-configuration" });
    expect(doc.components!.securitySchemes).toEqual({
      bearerAuth: { type: "http", scheme: "bearer" },
      jwt: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      basic: { type: "http", scheme: "basic" },
      exampleKey: { type: "apiKey", in: "header", name: "x-example-key" },
      oauth,
      oidc: { type: "openIdConnect", openIdConnectUrl: "https://id.example.com/.well-known/openid-configuration" },
    });
  });

  test("missing fields are named", () => {
    const doc = documentOf();
    expect(() => addSecurityScheme(doc, "oauth", { type: "oauth2", flows: { clientCredentials: { scopes: {} } } } as never)).toThrow(
      "Security scheme oauth: flows.clientCredentials.tokenUrl is required",
    );
    expect(() => addSecurityScheme(doc, "key", { type: "apiKey", in: "header" } as never)).toThrow("Security scheme key: name is required");
    expect(() => addSecurityScheme(doc, "oidc", { type: "openIdConnect" } as never)).toThrow("Security scheme oidc: openIdConnectUrl is required");
    expect(() => addSecurityScheme(doc, "odd", { type: "mutualTLS" } as never)).toThrow('Security scheme odd: type must be "http", "apiKey", "oauth2" or "openIdConnect"');
    expect(() => addSecurityScheme(doc, "bearerAuth", { type: "http", scheme: "bearer" })).toThrow("Security scheme bearerAuth already exists");
  });
});

describe("requireSecurity", () => {
  test("adds the requirement with scopes to the accepted operations only", () => {
    const doc = documentOf();
    addSecurityScheme(doc, "oidc", { type: "openIdConnect", openIdConnectUrl: "https://id.example.com/.well-known/openid-configuration" });
    requireSecurity(doc, "oidc", { scopes: ["read"], operations: (method) => method === "get" });
    expect((doc.paths["/users"]!.get as { security: unknown }).security).toEqual([{ oidc: ["read"] }]);
    expect((doc.paths["/users/{id}"]!.get as { security: unknown }).security).toEqual([{ oidc: ["read"] }]);
    expect((doc.paths["/users"]!.post as { security?: unknown }).security).toBeUndefined();
    expect((doc.paths["/users/{id}"]!.delete as { security: unknown }).security).toEqual([{ bearerAuth: [] }]);
    requireSecurity(doc, "bearerAuth", { operations: (_method, path) => path === "/users" });
    expect((doc.paths["/users"]!.post as { security: unknown }).security).toEqual([{ bearerAuth: [] }]);
  });

  test("an unknown scheme fails", () => {
    expect(() => requireSecurity(documentOf(), "nope")).toThrow("Security scheme nope is not defined; add it with addSecurityScheme first");
  });
});

describe("schemas and operations", () => {
  test("are added, and duplicates fail", () => {
    const doc = documentOf();
    addSchema(doc, "Status", { type: "object", properties: { ok: { type: "boolean" } } });
    addOperation(doc, "GET", "/example/status", { summary: "Status", responses: { "200": { description: "OK" } } });
    expect(doc.components!.schemas!.Status).toEqual({ type: "object", properties: { ok: { type: "boolean" } } });
    expect(doc.paths["/example/status"]!.get).toEqual({ summary: "Status", responses: { "200": { description: "OK" } } });
    expect(() => addSchema(doc, "User", {})).toThrow("Schema User already exists");
    expect(() => addOperation(doc, "get", "/users", {})).toThrow("Operation GET /users already exists");
    expect(() => addOperation(doc, "FETCH", "/x", {})).toThrow("Invalid method FETCH");
  });
});
