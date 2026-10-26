import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "@scalar/openapi-parser";
import { createApp, memoryAdapter, resolveConfig } from "@quickservicets/core";
import { parseEndpointTags } from "../hooks/endpoint-tags.ts";
import { createLinkedProject, MEMORY_CONFIG } from "../testing/project.ts";
import { build } from "./build.ts";

const MEMBERS = (tags: string, body: string) => `import type { Endpoint } from "@quickservicets/core";
type AddMember = { email: string };
/** @summary Add a member ${tags} */
const handler: Endpoint<AddMember, { members: number }> = async (repos, req, res) => {
  ${body}
  return { members: 1 };
};
export default handler;
`;

async function project(files: Record<string, string>) {
  const root = createLinkedProject({
    "quickservicets.config.ts": MEMORY_CONFIG,
    "entities/Organization.ts": "export type Organization = { name: string }",
    ...files,
  });
  await build(root);
  const generated = join(root, ".generated");
  const { models } = await import(join(generated, "models.ts"));
  const { crudRoutes, endpoints, hooks } = await import(join(generated, "routes.ts"));
  const database = memoryAdapter();
  await database.connect(models);
  const config = resolveConfig({ database, logger: { info() {}, warn() {}, error() {} } }, {});
  const { server } = createApp({ models, crudRoutes, endpoints, hooks, config });
  const send = async (method: string, path: string) => {
    const response = await server.fetch(
      new Request(`http://x${path}`, { method, headers: { "content-type": "application/json" }, ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }) }),
    );
    return { status: response.status, text: await response.text() };
  };
  const document = JSON.parse(readFileSync(join(generated, "openapi.json"), "utf8"));
  return { send, document };
}

const MEMBERS_PATH = "/organizations/{orgId}/members";

describe("tag", () => {
  test("reads a 2xx code", () => {
    expect(parseEndpointTags("/** @status 201 */\nexport default () => ({});", "endpoints/a/post.ts").metadata.status).toBe(201);
    expect(parseEndpointTags("/** @status 299 */\nexport default () => ({});", "endpoints/a/post.ts").metadata.status).toBe(299);
    expect(parseEndpointTags("/** @status 201 */\nexport default () => ({});", "endpoints/a/post.ts").hooks).toEqual([]);
  });

  test("other values fail the build", async () => {
    for (const value of ["404", "abc", "", "199", "300", "2.5e2"]) {
      const root = createLinkedProject({
        "quickservicets.config.ts": MEMORY_CONFIG,
        "endpoints/jobs/post.ts": `/** @status ${value} */\nexport default () => ({});`,
      });
      await expect(build(root)).rejects.toThrow("endpoints/jobs/post.ts: invalid @status: expects a 2xx status code");
    }
  });
});

describe("runtime", () => {
  test("the tag sets the status unless the handler calls res.status", async () => {
    const { send } = await project({
      "endpoints/organizations/[orgId]/members/post.ts": MEMBERS("@status 201", ""),
      "endpoints/organizations/[orgId]/members/put.ts": MEMBERS("@status 201", "res.status(202);"),
      "endpoints/organizations/[orgId]/members/delete.ts": "/** @status 204 */\nexport default () => undefined;",
      "endpoints/jobs/post.ts": "/** @status 202 */\nexport default () => undefined;",
    });
    expect(await send("POST", "/organizations/o1/members")).toEqual({ status: 201, text: '{"members":1}' });
    expect((await send("PUT", "/organizations/o1/members")).status).toBe(202);
    expect(await send("DELETE", "/organizations/o1/members")).toEqual({ status: 204, text: "" });
    expect(await send("POST", "/jobs")).toEqual({ status: 202, text: "" });
  });
});

describe("docs", () => {
  test("the success response uses the tag's code; 204 has no content", async () => {
    const { document } = await project({
      "endpoints/organizations/[orgId]/members/post.ts": MEMBERS("@status 201", ""),
      "endpoints/organizations/[orgId]/members/delete.ts": "/** @status 204 */\nexport default () => undefined;",
      "endpoints/organizations/[orgId]/get.ts": "/** @status 203 */\nexport default () => ({});",
      "endpoints/organizations/[orgId]/delete.ts": "/** @status 202 */\nexport default () => undefined;",
    });
    const post = document.paths[MEMBERS_PATH].post.responses;
    expect(Object.keys(post)).toEqual(["201"]);
    expect(post["201"].content["application/json"].schema).toEqual({
      type: "object",
      properties: { members: { type: "number" } },
      required: ["members"],
    });
    expect(document.paths[MEMBERS_PATH].delete.responses).toEqual({ "204": { description: "Success" } });
    // Overrides move the generated success response to the tag's code.
    const read = document.paths["/organizations/{orgId}"].get.responses;
    expect(read).not.toHaveProperty("200");
    expect(read["203"].content["application/json"].schema).toEqual({ $ref: "#/components/schemas/Organization" });
    expect(read).toHaveProperty("404");
    const remove = document.paths["/organizations/{orgId}"].delete.responses;
    expect(remove).not.toHaveProperty("204");
    expect(remove["202"].content["application/json"].schema).toEqual({ type: "object" });
    expect((await validate(structuredClone(document))).errors).toEqual([]);
  });
});

describe("without the tag", () => {
  test("statuses and docs stay 200, or 204 for undefined", async () => {
    const { send, document } = await project({
      "endpoints/organizations/[orgId]/members/post.ts": MEMBERS("", ""),
      "endpoints/organizations/[orgId]/members/delete.ts": "export default () => undefined;",
      "endpoints/organizations/[orgId]/members/put.ts": MEMBERS("", "res.status(201);"),
    });
    expect(await send("POST", "/organizations/o1/members")).toEqual({ status: 200, text: '{"members":1}' });
    expect(await send("DELETE", "/organizations/o1/members")).toEqual({ status: 204, text: "" });
    expect((await send("PUT", "/organizations/o1/members")).status).toBe(201);
    expect(Object.keys(document.paths[MEMBERS_PATH].post.responses)).toEqual(["200"]);
    expect(document.paths[MEMBERS_PATH].delete.responses).toEqual({ "204": { description: "Success" } });
  });
});
