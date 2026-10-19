import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { validate } from "@scalar/openapi-parser";
import { crudTable } from "../build/build.ts";
import { parseProjectEntities } from "../entities/parse-entities.ts";
import { createProject } from "../testing/project.ts";
import { generateOpenApi, type JsonSchema } from "./generate-openapi.ts";

const entities = {
  "entities/User.ts": `import type { Organization } from "./Organization.ts";
export type User = {
  /** @unique @format email */
  email: string;
  /** @hidden */
  passwordHash: string;
  /** @default 'member' */
  role: "member" | "admin";
  /** @min 0 @max 150 */
  age?: number;
  birthday?: Date;
  /** @minItems 1 @maxItems 5 */
  tags: string[];
  address?: { city: string; zip?: string; /** @hidden */ note?: string };
  /** @format url @minLength 8 */
  website?: string;
  active: boolean;
  organization?: Organization;
};`,
  "entities/Organization.ts": "export type Organization = {\n  /** @minLength 2 @maxLength 50 */\n  name: string;\n}",
  "entities/Tag.ts": "export type Tag = { label: string }",
  "entities/AuditLog.ts": "/** @internal */\nexport type AuditLog = { action: string }",
};

function documentFor(files: Record<string, string>, packageJson = { name: "acme-api", version: "1.2.3" }) {
  const models = parseProjectEntities(createProject(files));
  return generateOpenApi({ models, routes: crudTable(models), packageJson });
}

const schemaOf = (doc: ReturnType<typeof documentFor>, name: string) => doc.components.schemas[name] as JsonSchema & {
  properties: Record<string, JsonSchema>;
  required?: string[];
};

describe("document", () => {
  test("is OpenAPI 3.1 with the package name and version", () => {
    const doc = documentFor(entities);
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info).toEqual({ title: "acme-api", version: "1.2.3" });
  });

  test("validates for examples/basic", async () => {
    const root = join(import.meta.dir, "../../../../examples/basic");
    const models = parseProjectEntities(root);
    const packageJson = await Bun.file(join(root, "package.json")).json();
    const doc = generateOpenApi({ models, routes: crudTable(models), packageJson });
    expect(doc.info.title).toBe("basic-example");
    const result = await validate(structuredClone(doc) as unknown as Record<string, unknown>);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("validates with every field kind", async () => {
    const result = await validate(structuredClone(documentFor(entities)) as unknown as Record<string, unknown>);
    expect(result.errors).toEqual([]);
  });

  test("the validator rejects broken documents", async () => {
    const doc = documentFor(entities) as unknown as { paths: Record<string, Record<string, Record<string, unknown>>> };
    doc.paths["/users"]!.get!.responses = "nope";
    expect((await validate(doc)).valid).toBe(false);
  });

  test("is deterministic", () => {
    const shuffled = Object.fromEntries(Object.entries(entities).reverse());
    expect(JSON.stringify(documentFor(shuffled))).toBe(JSON.stringify(documentFor(entities)));
  });
});

describe("schemas", () => {
  test("map every field kind and tag", () => {
    const doc = documentFor(entities);
    expect(doc.components.schemas.User).toMatchSnapshot();
    expect(doc.components.schemas.UserCreate).toMatchSnapshot();
  });

  test("hidden fields only appear in write schemas", () => {
    const doc = documentFor(entities);
    expect(schemaOf(doc, "User").properties).not.toHaveProperty("passwordHash");
    expect(schemaOf(doc, "User").properties.address!.properties).not.toHaveProperty("note");
    for (const name of ["UserCreate", "UserReplace", "UserUpdate"]) {
      expect(schemaOf(doc, name).properties).toHaveProperty("passwordHash");
      expect((schemaOf(doc, name).properties.address as { properties: object }).properties).toHaveProperty("note");
    }
  });

  test("required lists follow the operation", () => {
    const doc = documentFor(entities);
    expect(schemaOf(doc, "UserCreate").required).toEqual(["email", "passwordHash", "tags", "active"]);
    expect(schemaOf(doc, "UserReplace").required).toEqual(["email", "passwordHash", "role", "tags", "active"]);
    expect(schemaOf(doc, "UserUpdate").required).toBeUndefined();
    expect(schemaOf(doc, "User").required).toEqual(["id", "createdAt", "updatedAt", "email", "role", "tags", "active"]);
  });

  test("defaults, formats and nullable optional fields", () => {
    const create = schemaOf(documentFor(entities), "UserCreate").properties;
    expect(create.role).toEqual({ type: "string", enum: ["member", "admin"], default: "member" });
    expect(create.email).toEqual({ type: "string", format: "email" });
    expect(create.website).toEqual({ type: ["string", "null"], minLength: 8, format: "uri" });
    expect(create.organization).toEqual({ type: ["string", "null"], format: "uuid" });
    expect(create.birthday).toEqual({ type: ["string", "null"], format: "date-time" });
    expect(create.age).toEqual({ type: ["number", "null"], minimum: 0, maximum: 150 });
    expect(create.tags).toEqual({ type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 });
  });

  test("read-only fields are not writable", () => {
    const doc = documentFor({});
    expect(schemaOf(doc, "Media").properties).toHaveProperty("storage");
    expect(schemaOf(doc, "MediaCreate").properties).not.toHaveProperty("storage");
    expect(schemaOf(doc, "MediaUpdate").properties).not.toHaveProperty("url");
  });
});

describe("integer fields", () => {
  test("use type integer in the entity and write schemas, nested ones included", async () => {
    const doc = documentFor({
      "entities/Product.ts": "export type Product = { /** @integer @min 0 */ stock: number; /** @integer */ reserved?: number; price: number; size?: { /** @integer */ units: number } }",
    });
    for (const name of ["Product", "ProductCreate", "ProductUpdate"]) {
      const schema = schemaOf(doc, name);
      expect(schema.properties.stock).toEqual({ type: "integer", minimum: 0 });
      expect(schema.properties.reserved).toEqual({ type: ["integer", "null"] });
      expect(schema.properties.price).toEqual({ type: "number" });
    }
    const size = schemaOf(doc, "ProductCreate").properties.size as JsonSchema & { properties: Record<string, JsonSchema> };
    expect(size.properties.units).toEqual({ type: "integer" });
    expect((await validate(structuredClone(doc))).errors).toEqual([]);
  });
});

describe("paths", () => {
  test("cover every CRUD operation with ids, bodies and responses", () => {
    const doc = documentFor(entities);
    const collection = doc.paths["/users"] as Record<string, any>;
    const item = doc.paths["/users/{id}"] as Record<string, any>;
    expect(Object.keys(collection)).toEqual(["get", "post"]);
    expect(Object.keys(item)).toEqual(["get", "put", "patch", "delete"]);
    expect(collection.get.operationId).toBe("listUser");
    expect(collection.post.operationId).toBe("createUser");
    expect(item.get.operationId).toBe("readUser");
    expect(item.put.operationId).toBe("replaceUser");
    expect(item.patch.operationId).toBe("updateUser");
    expect(item.delete.operationId).toBe("deleteUser");
    expect(collection.get.tags).toEqual(["users"]);
    expect(item.get.parameters.filter((parameter: { in: string }) => parameter.in === "path")).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
    ]);
    expect(collection.post.requestBody.content["application/json"].schema).toEqual({ $ref: "#/components/schemas/UserCreate" });
    expect(item.put.requestBody.content["application/json"].schema).toEqual({ $ref: "#/components/schemas/UserReplace" });
    expect(item.patch.requestBody.content["application/json"].schema).toEqual({ $ref: "#/components/schemas/UserUpdate" });
    expect(collection.get.responses["200"].content["application/json"].schema.required).toEqual(["data", "total", "limit", "offset"]);
    expect(Object.keys(collection.post.responses)).toEqual(["201", "400", "409"]);
    expect(Object.keys(item.get.responses)).toEqual(["200", "404"]);
    expect(Object.keys(item.patch.responses)).toEqual(["200", "400", "404", "409"]);
    expect(item.delete.responses["204"]).toEqual({ description: "The User was deleted" });
    expect(item.get.responses["404"].content["application/json"].schema).toEqual({ $ref: "#/components/schemas/Error" });
  });

  test("409 appears only for unique fields and referenced entities", () => {
    const doc = documentFor(entities) as unknown as { paths: Record<string, Record<string, any>> };
    expect(Object.keys(doc.paths["/organizations"]!.post.responses)).toEqual(["201", "400"]);
    expect(Object.keys(doc.paths["/organizations/{id}"]!.delete.responses)).toEqual(["204", "404", "409"]);
    expect(Object.keys(doc.paths["/tags/{id}"]!.delete.responses)).toEqual(["204", "404"]);
    expect(Object.keys(doc.paths["/users/{id}"]!.delete.responses)).toEqual(["204", "404"]);
  });

  test("internal entities have schemas but no paths", () => {
    const doc = documentFor(entities);
    expect(doc.components.schemas).toHaveProperty("AuditLog");
    expect(Object.keys(doc.paths).some((path) => path.startsWith("/audit"))).toBe(false);
  });

  test("list parameters document paging, sorting and filters", () => {
    const list = (documentFor(entities).paths["/users"] as Record<string, any>).get;
    const [limit, offset, sort, where] = list.parameters;
    expect(limit).toEqual({ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } });
    expect(offset).toEqual({ name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } });
    expect(sort.description).toContain("Default: `-createdAt`");
    expect(sort.description).toContain("`email`");
    expect(sort.description).not.toContain("`passwordHash`");
    expect(where.name).toBe("where");
    expect(where.description).toContain("- `email`: eq, ne, in, nin, exists, isNull, contains, startsWith");
    expect(where.description).toContain("- `age`: eq, ne, in, nin, exists, isNull, gt, gte, lt, lte");
    expect(where.description).not.toContain("passwordHash");
  });
});

describe("schemas and names", () => {
  test("entities sharing a name across schemas get prefixed components and schema tags", () => {
    const doc = documentFor({
      "entities/User.ts": "export type User = { email: string }",
      "entities/auth/User.ts": "export type User = { login: string }",
    });
    expect(doc.components.schemas).toHaveProperty("User");
    expect(doc.components.schemas).toHaveProperty("AuthUser");
    expect(doc.components.schemas).toHaveProperty("AuthUserCreate");
    expect(schemaOf(doc, "AuthUser").properties).toHaveProperty("login");
    const list = (doc.paths["/auth/users"] as Record<string, any>).get;
    expect(list.tags).toEqual(["auth/users"]);
    expect(list.operationId).toBe("listAuthUser");
    expect(doc.tags.map((tag) => tag.name)).toContain("auth/users");
  });
});
