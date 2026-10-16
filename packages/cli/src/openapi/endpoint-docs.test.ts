import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "@scalar/openapi-parser";
import { build, crudTable } from "../build/build.ts";
import { scanEndpoints } from "../endpoints/scan-endpoints.ts";
import { parseProjectEntities } from "../entities/parse-entities.ts";
import { parseEndpointTags } from "../hooks/endpoint-tags.ts";
import { createLinkedProject, MEMORY_CONFIG } from "../testing/project.ts";
import { describeEndpoints } from "./endpoint-docs.ts";
import { generateOpenApi } from "./generate-openapi.ts";

const entities = {
  "entities/Organization.ts": "export type Organization = { name: string; slug: string }",
  "entities/User.ts": "export type User = { email: string; /** @hidden */ passwordHash: string }",
};

const endpoint = (body: string, imports = "") =>
  `import type { Endpoint } from "@quickservice/core";\n${imports}\n${body}\n`;

function documentFor(files: Record<string, string>) {
  const root = createLinkedProject({ ...entities, ...files });
  const models = parseProjectEntities(root);
  const routes = crudTable(models);
  const inputs = scanEndpoints(root).map((route) => {
    const { metadata } = parseEndpointTags(readFileSync(join(root, route.file), "utf8"), route.file);
    const generated = routes.find(
      (candidate) => candidate.method === route.method && candidate.path.replace(/\[[^\]]+\]/g, ":") === route.pattern,
    );
    return { route, metadata, override: generated ? { entity: generated.entity, operation: generated.operation } : undefined };
  });
  const { docs, warnings } = describeEndpoints(root, models, inputs);
  const doc = generateOpenApi({ models, routes, packageJson: { name: "api", version: "1.0.0" }, endpoints: docs });
  return { doc: doc as unknown as { paths: Record<string, Record<string, any>> }, warnings, raw: doc };
}

describe("texts", () => {
  test("summary and multi-line description", () => {
    const { doc } = documentFor({
      "endpoints/organizations/[orgId]/stats/get.ts": endpoint(
        "/**\n * @summary Get organization stats\n * @description Counts members\n * and projects.\n */\nexport default (async () => ({})) as Endpoint;",
      ),
    });
    const operation = doc.paths["/organizations/{orgId}/stats"]!.get;
    expect(operation.summary).toBe("Get organization stats");
    expect(operation.description).toBe("Counts members\nand projects.");
  });

  test("@summary and @description are not hooks", () => {
    const tags = parseEndpointTags("/** @summary Stats @authorized */\nexport default () => ({});", "endpoints/stats/get.ts");
    expect(tags.hooks).toEqual([{ name: "authorized", args: [] }]);
    expect(tags.metadata.summary).toBe("Stats");
  });

  test("an endpoint with @summary and a hook builds with only that hook", async () => {
    const root = createLinkedProject({
      "quickservice.config.ts": MEMORY_CONFIG,
      "hooks/authorized.ts": 'import { definePreHook } from "@quickservice/core";\nexport default definePreHook(() => {});',
      "endpoints/stats/get.ts": "/** @summary Stats @authorized */\nexport default () => ({});",
    });
    await build(root);
    const routes = readFileSync(join(root, ".generated/routes.ts"), "utf8");
    expect(routes).toContain('hooks: [{"name":"authorized","args":[]}]');
  });
});

describe("generics", () => {
  test("body and result types, with entity references", async () => {
    const { doc, raw } = documentFor({
      "endpoints/organizations/post.ts": endpoint(
        "const h: Endpoint<{ name: string }, Organization> = async () => ({ id: '', name: '', slug: '' }) as never;\nexport default h;",
        'import type { Organization } from "../../entities/Organization.ts";',
      ),
    });
    const operation = doc.paths["/organizations"]!.post;
    expect(operation.requestBody.content["application/json"].schema).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });
    expect(operation.responses["201"].content["application/json"].schema).toEqual({ $ref: "#/components/schemas/Organization" });
    expect((await validate(structuredClone(raw) as unknown as Record<string, unknown>)).errors).toEqual([]);
  });

  test("primitives, nested objects, arrays, enums, dates and aliases", () => {
    const { doc, warnings } = documentFor({
      "endpoints/reports/post.ts": endpoint(
        `type Range = { from: Date; to?: Date | null };
interface Report { title: string; count: number; done: boolean; tags: string[]; ranges: Array<Range>; status: "draft" | "final"; owner: User; members: User[]; logo?: Media }
const h: Endpoint<{ range: Range; kind?: "a" | "b" }, Report> = async () => ({}) as never;
export default h;`,
        'import type { Media } from "@quickservice/core";\nimport type { User } from "../../entities/User.ts";',
      ),
    });
    expect(warnings).toEqual([]);
    const operation = doc.paths["/reports"]!.post;
    expect(operation.requestBody.content["application/json"].schema).toEqual({
      type: "object",
      properties: {
        range: {
          type: "object",
          properties: { from: { type: "string", format: "date-time" }, to: { type: ["string", "null"], format: "date-time" } },
          required: ["from"],
        },
        kind: { type: "string", enum: ["a", "b"] },
      },
      required: ["range"],
    });
    const result = operation.responses["200"].content["application/json"].schema;
    expect(result.required).toEqual(["title", "count", "done", "tags", "ranges", "status", "owner", "members"]);
    expect(result.properties.count).toEqual({ type: "number" });
    expect(result.properties.done).toEqual({ type: "boolean" });
    expect(result.properties.tags).toEqual({ type: "array", items: { type: "string" } });
    expect(result.properties.ranges.items.properties.from).toEqual({ type: "string", format: "date-time" });
    expect(result.properties.status).toEqual({ type: "string", enum: ["draft", "final"] });
    expect(result.properties.owner).toEqual({ $ref: "#/components/schemas/User" });
    expect(result.properties.members).toEqual({ type: "array", items: { $ref: "#/components/schemas/User" } });
    expect(result.properties.logo).toEqual({ $ref: "#/components/schemas/Media" });
  });

  test("unsupported types fall back to object with a warning", () => {
    const { doc, warnings } = documentFor({
      "endpoints/stats/get.ts": endpoint("const h: Endpoint<unknown, Map<string, number>> = async () => new Map() as never;\nexport default h;"),
    });
    expect(doc.paths["/stats"]!.get.responses["200"].content["application/json"].schema).toEqual({ type: "object" });
    expect(warnings).toEqual(["endpoints/stats/get.ts: cannot document type Map<string, number>; using object"]);
  });

  test("the build prints the warning and does not fail", async () => {
    const root = createLinkedProject({
      "quickservice.config.ts": MEMORY_CONFIG,
      "endpoints/stats/get.ts": endpoint("const h: Endpoint<unknown, Map<string, number>> = async () => new Map() as never;\nexport default h;"),
    });
    const summary = await build(root);
    expect(summary.warnings).toContain("endpoints/stats/get.ts: cannot document type Map<string, number>; using object");
  });

  test("without generics, bodies and responses are objects; delete without a result is 204", () => {
    const { doc } = documentFor({
      "endpoints/jobs/post.ts": "export default () => ({});",
      "endpoints/jobs/[jobId]/delete.ts": "export default () => undefined;",
      "endpoints/jobs/get.ts": endpoint("export default (async () => []) satisfies Endpoint<unknown, string[]>;"),
    });
    const post = doc.paths["/jobs"]!.post;
    expect(post.requestBody.content["application/json"].schema).toEqual({ type: "object" });
    expect(post.responses).toEqual({ "200": { description: "Success", content: { "application/json": { schema: { type: "object" } } } } });
    expect(doc.paths["/jobs/{jobId}"]!.delete.responses).toEqual({ "204": { description: "Success" } });
    expect(doc.paths["/jobs"]!.get.responses["200"].content["application/json"].schema).toEqual({ type: "array", items: { type: "string" } });
    expect(doc.paths["/jobs"]!.get).not.toHaveProperty("requestBody");
  });
});

describe("paths", () => {
  test("path parameters, tag and operation id", () => {
    const { doc } = documentFor({
      "endpoints/organizations/[orgId]/get.ts": "export default () => ({});",
      "endpoints/organizations/[orgId]/members/[memberId]/get.ts": "export default () => ({});",
      "endpoints/get.ts": "export default () => ({});",
    });
    const operation = doc.paths["/organizations/{orgId}"]!.get;
    expect(operation.parameters).toEqual([{ name: "orgId", in: "path", required: true, schema: { type: "string" } }]);
    expect(operation.tags).toEqual(["organizations"]);
    expect(operation.operationId).toBe("getOrganizationsOrgId");
    const member = doc.paths["/organizations/{orgId}/members/{memberId}"]!.get;
    expect(member.parameters.map((parameter: { name: string }) => parameter.name)).toEqual(["orgId", "memberId"]);
    expect(member.operationId).toBe("getOrganizationsOrgIdMembersMemberId");
    expect(doc.paths["/"]!.get.tags).toEqual(["root"]);
    expect(doc.paths["/"]!.get.operationId).toBe("getRoot");
  });
});

describe("overrides", () => {
  test("without generics, the generated operation is inherited", () => {
    const { doc } = documentFor({ "endpoints/users/[id]/get.ts": "export default () => ({});" });
    const operation = doc.paths["/users/{id}"]!.get;
    expect(operation.operationId).toBe("getUsersId");
    expect(operation.tags).toEqual(["users"]);
    expect(operation.responses["200"].content["application/json"].schema).toEqual({ $ref: "#/components/schemas/User" });
    expect(operation.responses["404"].content["application/json"].schema).toEqual({ $ref: "#/components/schemas/Error" });
  });

  test("the endpoint's parameter names, generics and texts take precedence", () => {
    const { doc } = documentFor({
      "endpoints/users/[userId]/patch.ts": endpoint(
        "/** @summary Rename */\nconst h: Endpoint<{ email: string }, { ok: boolean }> = async () => ({ ok: true });\nexport default h;",
      ),
    });
    expect(doc.paths["/users/{id}"]?.patch).toBeUndefined();
    const operation = doc.paths["/users/{userId}"]!.patch;
    expect(operation.summary).toBe("Rename");
    expect(operation.operationId).toBe("patchUsersUserId");
    expect(operation.parameters[0]).toMatchObject({ name: "userId", in: "path", required: true });
    expect(operation.requestBody.content["application/json"].schema.properties).toEqual({ email: { type: "string" } });
    expect(operation.responses["200"].content["application/json"].schema.properties).toEqual({ ok: { type: "boolean" } });
    expect(operation.responses).toHaveProperty("404");
    expect(doc.paths["/users/{id}"]!.get.operationId).toBe("readUser");
  });
});
