import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "@scalar/openapi-parser";
import { crudTable } from "../build/build.ts";
import { scanEndpoints } from "../endpoints/scan-endpoints.ts";
import { parseProjectEntities } from "../entities/parse-entities.ts";
import { parseEndpointTags } from "../hooks/endpoint-tags.ts";
import { createLinkedProject } from "../testing/project.ts";
import { describeEndpoints } from "./endpoint-docs.ts";
import { generateOpenApi, projectSchema, schemaPaths } from "./generate-openapi.ts";

const address = "address: { city: string; zip?: string }";

function documentFor(files: Record<string, string>) {
  const root = createLinkedProject(files);
  const models = parseProjectEntities(root);
  const routes = crudTable(models);
  const inputs = scanEndpoints(root).map((route) => {
    const { metadata } = parseEndpointTags(readFileSync(join(root, route.file), "utf8"), route.file);
    const generated = routes.find(
      (candidate) => candidate.method === route.method && candidate.path.replace(/\[[^\]]+\]/g, ":") === route.pattern,
    );
    return { route, metadata, override: generated ? { entity: generated.entity, operation: generated.operation } : undefined };
  });
  const { docs } = describeEndpoints(root, models, inputs);
  const doc = generateOpenApi({ models, routes, packageJson: { name: "api", version: "1.0.0" }, endpoints: docs });
  return { doc: doc as unknown as { paths: Record<string, Record<string, any>>; components: { schemas: Record<string, any> } }, raw: doc };
}

const listItems = (doc: ReturnType<typeof documentFor>["doc"], path: string) =>
  doc.paths[path]!.get.responses["200"].content["application/json"].schema.properties.data.items;
const readSchema = (doc: ReturnType<typeof documentFor>["doc"], path: string) =>
  doc.paths[path]!.get.responses["200"].content["application/json"].schema;

describe("per-operation schemas", () => {
  test("a field hidden on list gets a ListItem schema; read keeps the entity schema", async () => {
    const { doc, raw } = documentFor({ "entities/User.ts": `export type User = { email: string; /** @hidden:list */ ${address} }` });
    expect(listItems(doc, "/users")).toEqual({ $ref: "#/components/schemas/UserListItem" });
    expect(readSchema(doc, "/users/{id}")).toEqual({ $ref: "#/components/schemas/User" });
    expect(doc.components.schemas.UserListItem.properties).not.toHaveProperty("address");
    expect(doc.components.schemas.UserListItem.properties).toHaveProperty("email");
    expect(doc.components.schemas).not.toHaveProperty("UserRead");
    expect((await validate(structuredClone(raw) as unknown as Record<string, unknown>)).errors).toEqual([]);
  });

  test("@fields keeps nested paths only and makes every property optional", () => {
    const { doc } = documentFor({ "entities/User.ts": `/** @fields:list id,address.city */\nexport type User = { email: string; ${address} }` });
    const item = doc.components.schemas.UserListItem;
    expect(item).toEqual({
      type: "object",
      properties: { id: { type: "string", format: "uuid" }, address: { type: "object", properties: { city: { type: "string" } } } },
    });
    expect(doc.components.schemas.User.required).toContain("email");
  });

  test("hidden-on-read nested paths are dropped inside arrays of objects", () => {
    const { doc } = documentFor({
      "entities/Order.ts": "export type Order = { lines: { sku: string; /** @hidden:read */ cost: number }[] }",
    });
    expect(readSchema(doc, "/orders/{id}")).toEqual({ $ref: "#/components/schemas/OrderRead" });
    const lines = doc.components.schemas.OrderRead.properties.lines;
    expect(lines).toEqual({ type: "array", items: { type: "object", properties: { sku: { type: "string" } } } });
  });

  test("an entity exposing everything keeps a single schema", () => {
    const { doc } = documentFor({ "entities/Tag.ts": "export type Tag = { label: string }" });
    expect(listItems(doc, "/tags")).toEqual({ $ref: "#/components/schemas/Tag" });
    expect(doc.components.schemas).not.toHaveProperty("TagListItem");
    expect(doc.components.schemas).not.toHaveProperty("TagRead");
  });
});

describe("selection parameters", () => {
  test("list and read document fields and exclude with the selectable paths", () => {
    const { doc } = documentFor({ "entities/User.ts": `export type User = { email: string; ${address} }` });
    for (const path of ["/users", "/users/{id}"]) {
      const parameters = doc.paths[path]!.get.parameters as { name: string; in: string; required?: boolean; description: string }[];
      const fields = parameters.find((parameter) => parameter.name === "fields")!;
      const exclude = parameters.find((parameter) => parameter.name === "exclude")!;
      expect(fields).toMatchObject({ in: "query", required: false, schema: { type: "string" } });
      expect(exclude).toMatchObject({ in: "query", required: false, schema: { type: "string" } });
      expect(fields.description).toContain("`address.city`");
      expect(fields.description).toContain("`email`");
      expect(exclude.description).toContain("`address.city`");
    }
    expect(doc.paths["/users"]!.post.parameters).toBeUndefined();
  });

  test("selectable paths follow the operation's exposure", () => {
    const { doc } = documentFor({ "entities/User.ts": `export type User = { email: string; /** @hidden:list */ ${address} }` });
    const fields = (doc.paths["/users"]!.get.parameters as { name: string; description: string }[]).find((parameter) => parameter.name === "fields")!;
    expect(fields.description).not.toContain("address");
  });
});

describe("endpoint tags", () => {
  test("an override with @exclude documents a read schema without the path", () => {
    const { doc } = documentFor({
      "entities/User.ts": `export type User = { email: string; ${address} }`,
      "endpoints/users/[id]/get.ts": "/** @exclude address */\nexport default () => ({});",
    });
    const schema = readSchema(doc, "/users/{id}");
    expect(schema.properties).toHaveProperty("email");
    expect(schema.properties).not.toHaveProperty("address");
    expect(schema).not.toHaveProperty("required");
  });

  test("an override of list projects the items", () => {
    const { doc } = documentFor({
      "entities/User.ts": `export type User = { email: string; ${address} }`,
      "endpoints/users/get.ts": "/** @fields id,email */\nexport default () => ({});",
    });
    expect(Object.keys(listItems(doc, "/users").properties)).toEqual(["id", "email"]);
    expect(readSchema(doc, "/users").required).toEqual(["data", "total", "limit", "offset"]);
  });

  test("a custom endpoint with a known result is projected; an unknown one stays an object", () => {
    const { doc } = documentFor({
      "entities/User.ts": `export type User = { email: string; ${address} }`,
      "endpoints/me/get.ts":
        'import type { Endpoint } from "@quickservicets/core";\nimport type { User } from "../../entities/User.ts";\n/** @fields email */\nconst h: Endpoint<unknown, User> = async () => ({}) as never;\nexport default h;',
      "endpoints/stats/get.ts": "/** @fields total */\nexport default () => ({});",
    });
    expect(readSchema(doc, "/me").properties).toEqual({ email: { type: "string" } });
    expect(readSchema(doc, "/stats")).toEqual({ type: "object" });
  });
});

describe("helpers", () => {
  test("projectSchema returns undefined when nothing changes, and schemaPaths lists nested paths", () => {
    const schema = { type: "object", properties: { a: { type: "object", properties: { b: { type: "string" } } } } };
    expect(projectSchema(schema, { exclude: ["c"] })).toBeUndefined();
    expect(schemaPaths(schema)).toEqual(["a", "a.b"]);
  });
});
