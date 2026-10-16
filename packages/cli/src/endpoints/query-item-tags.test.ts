import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "@scalar/openapi-parser";
import { createApp, memoryAdapter, resolveConfig } from "@quickservice/core";
import { build } from "../build/build.ts";
import { createLinkedProject, MEMORY_CONFIG } from "../testing/project.ts";

const endpoint = (query: string, extra = "") =>
  `import type { Endpoint } from "@quickservice/core";\n${extra}\nconst handler: Endpoint<${query}, unknown> = async (_, req) => req.queryItems;\nexport default handler;\n`;

const MEMBERS = `import { HttpError, type Endpoint } from "@quickservice/core";
type MembersQuery = {
  /** @minLength 2 */
  search?: string;
  /** @default 20 @min 1 @max 100 */
  limit?: number;
};
type MemberList = { data: { id: string; email: string }[]; total: number };
/** @summary List an organization's members */
const handler: Endpoint<MembersQuery, MemberList> = async (repos, req) => {
  const organization = await repos.organizations.findById(req.params.orgId!);
  if (!organization) throw new HttpError(404, "Organization not found");
  return { data: [], total: req.queryItems.limit ?? 0 };
};
export default handler;
`;

async function project(files: Record<string, string>) {
  const root = createLinkedProject({ "quickservice.config.ts": MEMORY_CONFIG, ...files });
  await build(root);
  const generated = join(root, ".generated");
  const { models } = await import(join(generated, "models.ts"));
  const { crudRoutes, endpoints, hooks } = await import(join(generated, "routes.ts"));
  const database = memoryAdapter();
  await database.connect(models);
  const config = resolveConfig({ database, logger: { info() {}, warn() {}, error() {} } }, {});
  const { server } = createApp({ models, crudRoutes, endpoints, hooks, config });
  const send = async (path: string) => {
    const response = await server.fetch(new Request(`http://x${path}`));
    return { status: response.status, body: (await response.json()) as any };
  };
  const document = JSON.parse(readFileSync(join(generated, "openapi.json"), "utf8"));
  return { send, document };
}

const parametersOf = (document: any, path: string, method = "get"): Record<string, any> =>
  Object.fromEntries((document.paths[path][method].parameters as { name: string }[]).map((parameter) => [parameter.name, parameter]));

describe("defaults and limits", () => {
  test("defaults apply when absent; min, max and lengths are checked", async () => {
    const { send } = await project({
      "endpoints/report/get.ts": endpoint(
        "{ /** @default 20 @min 1 @max 100 */ limit?: number; /** @minLength 2 @maxLength 5 */ search?: string; /** @default [\"a\"] */ tags?: string[]; /** @default '2026-01-01' */ since?: Date }",
      ),
    });
    const defaults = await send("/report");
    expect(defaults.body).toEqual({ limit: 20, tags: ["a"], since: "2026-01-01T00:00:00.000Z" });
    expect((await send("/report?limit=500")).body.error.details).toEqual([{ field: "limit", message: "Must be at most 100" }]);
    expect((await send("/report?limit=0")).body.error.details).toEqual([{ field: "limit", message: "Must be at least 1" }]);
    expect((await send("/report?search=a")).body.error.details).toEqual([{ field: "search", message: "Must be at least 2 characters" }]);
    expect((await send("/report?search=abcdef")).body.error.details).toEqual([{ field: "search", message: "Must be at most 5 characters" }]);
    expect((await send("/report?search=ana&limit=7")).body).toMatchObject({ search: "ana", limit: 7 });
  });
});

describe("tag errors", () => {
  const fails = (query: string) =>
    expect(build(createLinkedProject({ "quickservice.config.ts": MEMORY_CONFIG, "endpoints/x/get.ts": endpoint(query) }))).rejects;

  test("misapplied, mismatched and unknown tags fail the build", async () => {
    await fails("{ /** @min 1 */ q?: string }").toThrow('endpoints/x/get.ts: query item "q" has invalid @min: only applies to number items');
    await fails("{ /** @maxLength 2 */ n?: number }").toThrow('query item "n" has invalid @maxLength: only applies to string items');
    await fails("{ /** @default 'x' */ n?: number }").toThrow('query item "n" has invalid @default: \'x\' does not match the item type');
    await fails("{ /** @unique */ q?: string }").toThrow('query item "q" has invalid @unique: is not supported on query items');
  });
});

describe("OpenAPI parameters", () => {
  test("the README members endpoint documents its items, and the document validates", async () => {
    const { document } = await project({
      "entities/User.ts": "export type User = { email: string }",
      "entities/Organization.ts": 'import type { User } from "./User.ts";\nexport type Organization = { name: string; members: User[] }',
      "endpoints/organizations/[orgId]/members/get.ts": MEMBERS,
    });
    const parameters = parametersOf(document, "/organizations/{orgId}/members");
    expect(parameters.orgId).toMatchObject({ in: "path", required: true });
    expect(parameters.search).toEqual({ name: "search", in: "query", required: false, schema: { type: "string", minLength: 2 } });
    expect(parameters.limit).toEqual({ name: "limit", in: "query", required: false, schema: { type: "number", minimum: 1, maximum: 100, default: 20 } });
    expect((await validate(structuredClone(document))).errors).toEqual([]);
  });

  test("arrays use form style; named enums reference their shared schema; required items", async () => {
    const { document } = await project({
      "endpoints/report/get.ts": endpoint(
        "{ tags?: string[]; status?: Status; orgId: string; since?: Date }",
        'export enum Status { Draft = "draft", Live = "live" }',
      ),
    });
    const parameters = parametersOf(document, "/report");
    expect(parameters.tags).toEqual({ name: "tags", in: "query", required: false, style: "form", explode: true, schema: { type: "array", items: { type: "string" } } });
    expect(parameters.status.schema).toEqual({ $ref: "#/components/schemas/Status" });
    expect(document.components.schemas.Status).toEqual({ type: "string", enum: ["draft", "live"] });
    expect(parameters.orgId.required).toBe(true);
    expect(parameters.since.schema).toEqual({ type: "string", format: "date-time" });
    expect((await validate(structuredClone(document))).errors).toEqual([]);
  });
});

describe("overrides", () => {
  test("a query type replaces the generated parameters; without one they are inherited", async () => {
    const { document } = await project({
      "entities/User.ts": "export type User = { email: string }",
      "entities/Team.ts": "export type Team = { name: string }",
      "endpoints/users/get.ts": endpoint("{ q: string }"),
      "endpoints/teams/get.ts": "export default () => ({ data: [], total: 0, limit: 20, offset: 0 });",
    });
    expect(Object.keys(parametersOf(document, "/users"))).toEqual(["q"]);
    expect(parametersOf(document, "/users").q.required).toBe(true);
    expect(Object.keys(parametersOf(document, "/teams"))).toEqual(expect.arrayContaining(["limit", "sort", "where"]));
  });
});
