import { describe, expect, test } from "bun:test";
import { validate } from "@scalar/openapi-parser";
import { localStorage, resolveConfig, memoryAdapter } from "@quickservicets/core";
import { crudTable } from "../build/build.ts";
import { parseProjectEntities } from "../entities/parse-entities.ts";
import { createProject } from "../testing/project.ts";
import { generateOpenApi } from "./generate-openapi.ts";

const entities = {
  "entities/Organization.ts": `import type { Media } from "@quickservicets/core";
export type Organization = {
  name: string;
  /** @maxSize 1MB @accept image/png,image/webp */
  logo?: Media;
  /** @maxTotalSize 5MB */
  gallery?: Media[];
};`,
  "entities/User.ts": 'import type { Organization } from "./Organization.ts";\nexport type User = { email: string; organization?: Organization; /** @hidden */ secret?: Organization }',
  "entities/Document.ts": 'import type { File } from "@quickservicets/core";\n/** @access proxy */\nexport type Document = File & { title?: string }',
  "entities/Contract.ts": 'import type { File } from "@quickservicets/core";\n/** @access signed 60 */\nexport type Contract = File & { party: string }',
  "entities/Tag.ts": "export type Tag = { label: string }",
};

function documentFor(options: { maxDepth?: number; publicBaseUrl?: string } = {}) {
  const models = parseProjectEntities(createProject(entities));
  const config = resolveConfig(
    {
      database: memoryAdapter(),
      storage: { default: localStorage({ dir: "/tmp/unused", publicBaseUrl: options.publicBaseUrl }) },
      files: { signingSecret: "secret" },
    },
    {},
  );
  const doc = generateOpenApi({
    models,
    routes: crudTable(models),
    packageJson: { name: "api", version: "1.0.0" },
    files: config,
    populateMaxDepth: options.maxDepth,
  });
  return { doc: doc as unknown as { paths: Record<string, Record<string, any>>; components: { schemas: Record<string, any> } }, raw: doc };
}

describe("file entities", () => {
  test("POST and PUT take only a multipart body with a required binary file", () => {
    const { doc } = documentFor();
    for (const operation of [doc.paths["/media"]!.post, doc.paths["/media/{id}"]!.put]) {
      expect(Object.keys(operation.requestBody.content)).toEqual(["multipart/form-data"]);
      const schema = operation.requestBody.content["multipart/form-data"].schema;
      expect(schema.properties.file).toEqual({ type: "string", format: "binary" });
      expect(schema.required).toEqual(["file"]);
      expect(operation.responses["413"].content["application/json"].schema).toEqual({ $ref: "#/components/schemas/Error" });
      expect(operation.responses["415"].description).toBe("Unsupported media type");
    }
    expect(Object.keys(doc.paths["/media/{id}"]!.patch.requestBody.content)).toEqual(["application/json"]);
  });

  test("the entity's extra fields are parts of the upload", () => {
    const schema = documentFor().doc.paths["/contracts"]!.post.requestBody.content["multipart/form-data"].schema;
    expect(Object.keys(schema.properties)).toEqual(["file", "party"]);
    expect(schema.required).toEqual(["file", "party"]);
    expect(schema.properties).not.toHaveProperty("storageKey");
  });
});

describe("entities with file references", () => {
  test("writes take JSON or multipart, with binary file parts and their limits", () => {
    const { doc } = documentFor();
    const create = doc.paths["/organizations"]!.post.requestBody.content;
    expect(Object.keys(create)).toEqual(["application/json", "multipart/form-data"]);
    expect(create["application/json"].schema).toEqual({ $ref: "#/components/schemas/OrganizationCreate" });
    const parts = create["multipart/form-data"].schema.properties;
    expect(parts.logo).toEqual({
      type: "string",
      format: "binary",
      description: "File upload. Max size: 1 MB. Accepted types: image/png, image/webp.",
    });
    expect(parts.gallery).toEqual({ type: "array", items: { type: "string", format: "binary" }, description: "File upload. Max total size: 5 MB." });
    expect(parts.name).toEqual({ type: "string" });
    for (const method of ["put", "patch"]) {
      expect(Object.keys(doc.paths["/organizations/{id}"]![method].requestBody.content)).toEqual(["application/json", "multipart/form-data"]);
    }
    expect(Object.keys(doc.paths["/tags"]!.post.requestBody.content)).toEqual(["application/json"]);
  });
});

describe("file routes", () => {
  test("proxy mode documents a binary download", () => {
    const operation = documentFor().doc.paths["/documents/{id}/file"]!.get;
    expect(operation.tags).toEqual(["documents"]);
    expect(operation.responses["200"].content).toEqual({ "*/*": { schema: { type: "string", format: "binary" } } });
    expect(Object.keys(operation.responses)).toEqual(["200", "404"]);
    expect(operation.parameters.map((parameter: { name: string }) => parameter.name)).toEqual(["id"]);
  });

  test("signed mode adds expires, signature and 403", () => {
    const operation = documentFor().doc.paths["/contracts/{id}/file"]!.get;
    expect(operation.parameters.map((parameter: { name: string }) => parameter.name)).toEqual(["id", "expires", "signature"]);
    expect(operation.parameters[1]).toMatchObject({ in: "query", required: true, schema: { type: "integer" } });
    expect(Object.keys(operation.responses)).toEqual(["200", "403", "404"]);
  });

  test("direct mode has no file route", () => {
    const { doc } = documentFor({ publicBaseUrl: "https://cdn.x" });
    expect(doc.paths["/media/{id}/file"]).toBeUndefined();
    expect(doc.paths["/documents/{id}/file"]).toBeDefined();
  });
});

describe("populate", () => {
  test("list and read document the allowed paths up to the maximum depth", () => {
    const { doc } = documentFor();
    for (const operation of [doc.paths["/users"]!.get, doc.paths["/users/{id}"]!.get]) {
      const populate = operation.parameters.find((parameter: { name: string }) => parameter.name === "populate");
      expect(populate).toMatchObject({ in: "query", required: false, schema: { type: "string" } });
      expect(populate.description).toContain("`organization`, `organization.logo`, `organization.gallery`");
      expect(populate.description).not.toContain("secret");
    }
    const shallow = documentFor({ maxDepth: 1 }).doc.paths["/users"]!.get.parameters.find((parameter: { name: string }) => parameter.name === "populate");
    expect(shallow.description).not.toContain("organization.logo");
    expect(documentFor().doc.paths["/tags"]!.get.parameters.some((parameter: { name: string }) => parameter.name === "populate")).toBe(false);
  });

  test("references are oneOf the id and the target's read schema", () => {
    const { doc } = documentFor();
    expect(doc.components.schemas.User.properties.organization).toEqual({
      oneOf: [{ type: "string", format: "uuid" }, { $ref: "#/components/schemas/Organization" }, { type: "null" }],
    });
    expect(doc.components.schemas.Organization.properties.gallery).toEqual({
      type: ["array", "null"],
      items: { oneOf: [{ type: "string", format: "uuid" }, { $ref: "#/components/schemas/Media" }] },
    });
  });

  test("a target with a projected read schema is referenced by it", () => {
    const models = parseProjectEntities(
      createProject({
        "entities/Team.ts": "export type Team = { name: string; /** @hidden:read */ budget?: number }",
        "entities/Member.ts": 'import type { Team } from "./Team.ts";\nexport type Member = { team: Team }',
      }),
    );
    const doc = generateOpenApi({ models, routes: crudTable(models), packageJson: {} });
    expect((doc.components.schemas.Member as any).properties.team.oneOf[1]).toEqual({ $ref: "#/components/schemas/TeamRead" });
  });
});

test("the document validates as OpenAPI 3.1", async () => {
  const result = await validate(structuredClone(documentFor().raw) as unknown as Record<string, unknown>);
  expect(result.errors).toEqual([]);
  expect(result.valid).toBe(true);
});
