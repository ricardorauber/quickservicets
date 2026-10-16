import { describe, expect, test } from "bun:test";
import { validate } from "@scalar/openapi-parser";
import { crudTable } from "../build/build.ts";
import { parseProjectEntities } from "../entities/parse-entities.ts";
import { createProject } from "../testing/project.ts";
import { generateOpenApi } from "./generate-openapi.ts";

const entities = {
  "entities/Organization.ts": `import type { Media } from "@quickservice/core";
import type { User } from "./User.ts";
export type Organization = {
  name: string;
  /** @minItems 1 @maxItems 50 */
  members: User[];
  /** @maxSize 2MB @maxTotalSize 10MB @accept image/* @maxItems 5 */
  gallery?: Media[];
};`,
  "entities/User.ts": 'import type { Organization } from "./Organization.ts";\nexport type User = { email: string; organization?: Organization }',
};

function documentFor() {
  const models = parseProjectEntities(createProject(entities));
  const doc = generateOpenApi({ models, routes: crudTable(models), packageJson: { name: "api", version: "1.0.0" } });
  return { doc: doc as unknown as { paths: Record<string, Record<string, any>>; components: { schemas: Record<string, any> } }, raw: doc };
}

const UUID = { type: "string", format: "uuid" };

describe("schemas", () => {
  test("responses type reference arrays as arrays of oneOf id and target", () => {
    const members = documentFor().doc.components.schemas.Organization.properties.members;
    expect(members).toEqual({
      type: "array",
      items: { oneOf: [UUID, { $ref: "#/components/schemas/User" }] },
      minItems: 1,
      maxItems: 50,
    });
  });

  test("create and replace bodies take unique ids", () => {
    const { schemas } = documentFor().doc.components;
    const list = { type: "array", items: UUID, minItems: 1, maxItems: 50, uniqueItems: true };
    expect(schemas.OrganizationCreate.properties.members).toEqual(list);
    expect(schemas.OrganizationReplace.properties.members).toEqual(list);
    expect(schemas.OrganizationCreate.required).toContain("members");
  });

  test("PATCH bodies take the full list or add/remove changes", () => {
    const members = documentFor().doc.components.schemas.OrganizationUpdate.properties.members;
    expect(members).toEqual({
      oneOf: [
        { type: "array", items: UUID, minItems: 1, maxItems: 50, uniqueItems: true },
        {
          type: "object",
          properties: { add: { type: "array", items: UUID, uniqueItems: true }, remove: { type: "array", items: UUID, uniqueItems: true } },
          additionalProperties: false,
        },
      ],
    });
    const gallery = documentFor().doc.components.schemas.OrganizationUpdate.properties.gallery;
    expect(gallery.oneOf).toHaveLength(3);
    expect(gallery.oneOf[2]).toEqual({ type: "null" });
    const operation = documentFor().doc.paths["/organizations/{id}"]!.patch;
    expect(operation.requestBody.content["application/json"].schema).toEqual({ $ref: "#/components/schemas/OrganizationUpdate" });
  });
});

describe("descriptions", () => {
  test("list filters include the reference array operators", () => {
    const where = documentFor().doc.paths["/organizations"]!.get.parameters.find((parameter: { name: string }) => parameter.name === "where");
    expect(where.description).toContain("- `members`: contains, containsAny, containsAll, size, isEmpty");
  });

  test("populate lists reference array paths", () => {
    const populate = documentFor().doc.paths["/organizations"]!.get.parameters.find((parameter: { name: string }) => parameter.name === "populate");
    expect(populate.description).toContain("`members`");
    expect(populate.description).toContain("`members.organization`");
    expect(populate.description).toContain("`gallery`");
  });
});

describe("multipart", () => {
  test("arrays of files are arrays of binaries with every limit described", () => {
    const parts = documentFor().doc.paths["/organizations"]!.post.requestBody.content["multipart/form-data"].schema.properties;
    expect(parts.gallery).toEqual({
      type: "array",
      items: { type: "string", format: "binary" },
      description: "File upload. Max size: 2 MB. Max total size: 10 MB. Accepted types: image/*. Max items: 5.",
    });
    expect(parts.members).toEqual({ type: "array", items: UUID, minItems: 1, maxItems: 50, uniqueItems: true });
  });
});

test("the document validates as OpenAPI 3.1", async () => {
  const result = await validate(structuredClone(documentFor().raw) as unknown as Record<string, unknown>);
  expect(result.errors).toEqual([]);
  expect(result.valid).toBe(true);
});
