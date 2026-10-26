import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp, memoryAdapter, parseQueryItems, resolveConfig, type QueryItem } from "@quickservicets/core";
import ts from "typescript";
import { build } from "../build/build.ts";
import { createLinkedProject, MEMORY_CONFIG } from "../testing/project.ts";
import { scanEndpoints } from "./scan-endpoints.ts";
import { extractQueryItems } from "./query-items.ts";

const ENDPOINT = (query: string, method = "GET", extra = "") =>
  `import type { Endpoint } from "@quickservicets/core";\n${extra}\nconst handler: Endpoint<${query}, unknown> = async (_, req) => ({ items: req.queryItems, raw: req.query.get("utm_source") });\nexport default handler;\n`;

function itemsOf(files: Record<string, string>) {
  const root = createLinkedProject(files);
  return extractQueryItems(root, scanEndpoints(root));
}

async function serve(files: Record<string, string>) {
  const root = createLinkedProject({ "quickservicets.config.ts": MEMORY_CONFIG, ...files });
  await build(root);
  const generated = join(root, ".generated");
  const { models } = await import(join(generated, "models.ts"));
  const { crudRoutes, endpoints, hooks } = await import(join(generated, "routes.ts"));
  const database = memoryAdapter();
  await database.connect(models);
  const config = resolveConfig({ database, logger: { info() {}, warn() {}, error() {} } }, {});
  const { server } = createApp({ models, crudRoutes, endpoints, hooks, config });
  return async (path: string, init: RequestInit = {}) => {
    const response = await server.fetch(new Request(`http://x${path}`, init));
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
}

describe("extraction", () => {
  test("type literals, aliases, interfaces and named enums on GET and DELETE", () => {
    const items = itemsOf({
      "endpoints/a/get.ts": ENDPOINT("{ search?: string; limit: number }"),
      "endpoints/b/get.ts": ENDPOINT("Filters", "GET", 'export enum Status { Draft = "draft", Live = "live" }\ntype Filters = { status?: Status; tags?: string[] };'),
      "endpoints/c/delete.ts": ENDPOINT("Options", "DELETE", "interface Options { force: boolean; before?: Date; mode?: \"soft\" | \"hard\" }"),
      "endpoints/d/post.ts": ENDPOINT("{ name: string }"),
      "endpoints/e/get.ts": ENDPOINT("unknown"),
    });
    expect(items.get("endpoints/a/get.ts")).toEqual([
      { name: "search", optional: true, type: "string" },
      { name: "limit", optional: false, type: "number" },
    ]);
    expect(items.get("endpoints/b/get.ts")).toEqual([
      { name: "status", optional: true, type: "enum", values: ["draft", "live"], enumName: "Status" },
      { name: "tags", optional: true, type: "array", items: { type: "string" } },
    ]);
    expect(items.get("endpoints/c/delete.ts")).toEqual([
      { name: "force", optional: false, type: "boolean" },
      { name: "before", optional: true, type: "date" },
      { name: "mode", optional: true, type: "enum", values: ["soft", "hard"] },
    ]);
    expect(items.has("endpoints/d/post.ts")).toBe(false);
    expect(items.has("endpoints/e/get.ts")).toBe(false);
  });

  test("unsupported item types and non-object query types fail the build", () => {
    expect(() => itemsOf({ "endpoints/a/get.ts": ENDPOINT("{ filter: { a: string } }") })).toThrow(
      'endpoints/a/get.ts: query item "filter" has unsupported type "{ a: string }"',
    );
    expect(() => itemsOf({ "endpoints/a/get.ts": ENDPOINT("{ level: 1 | 2 }") })).toThrow('query item "level" has unsupported type "1 | 2"');
    expect(() => itemsOf({ "endpoints/a/get.ts": ENDPOINT("string") })).toThrow("endpoints/a/get.ts: the query type must be an object type");
  });
});

describe("conversion", () => {
  const items: QueryItem[] = [
    { name: "search", optional: true, type: "string" },
    { name: "limit", optional: true, type: "number" },
    { name: "active", optional: true, type: "boolean" },
    { name: "since", optional: true, type: "date" },
    { name: "status", optional: true, type: "enum", values: ["draft", "published"] },
  ];
  const parse = (query: string) => parseQueryItems(items, new URLSearchParams(query));
  const failures = (query: string) => {
    try {
      parse(query);
      return [];
    } catch (error) {
      return (error as { details?: unknown[] }).details;
    }
  };

  test("every supported type", () => {
    expect(parse("search=ana&limit=10&active=true&since=2026-01-01&status=draft")).toEqual({
      search: "ana",
      limit: 10,
      active: true,
      since: new Date("2026-01-01"),
      status: "draft",
    });
  });

  test("each error message", () => {
    expect(failures("limit=abc&active=yes&since=tomorrow&status=Draft")).toEqual([
      { field: "limit", message: "Must be a number" },
      { field: "active", message: "Must be true or false" },
      { field: "since", message: "Must be an ISO 8601 date" },
      { field: "status", message: "Must be one of: draft, published" },
    ]);
  });
});

describe("arrays and repeated keys", () => {
  const items: QueryItem[] = [
    { name: "tags", optional: true, type: "array", items: { type: "string" } },
    { name: "limits", optional: true, type: "array", items: { type: "number" } },
    { name: "search", optional: true, type: "string" },
  ];

  test("arrays come from repeated keys", () => {
    expect(parseQueryItems(items, new URLSearchParams("tags=a&tags=b&limits=1&limits=2"))).toEqual({ tags: ["a", "b"], limits: [1, 2] });
  });

  test("array errors carry the index; repeated single items fail", () => {
    expect(() => parseQueryItems(items, new URLSearchParams("limits=1&limits=x&search=a&search=b"))).toThrow("Invalid query");
    try {
      parseQueryItems(items, new URLSearchParams("limits=1&limits=x&search=a&search=b"));
    } catch (error) {
      expect((error as { details: unknown }).details).toEqual([
        { field: "limits[1]", message: "Must be a number" },
        { field: "search", message: "Parameter is repeated" },
      ]);
    }
  });
});

describe("requests", () => {
  test("required items, ignored keys and the queryItems shape", async () => {
    const send = await serve({
      "endpoints/reports/get.ts": ENDPOINT("{ orgId: string; search?: string; tags?: string[] }"),
      "endpoints/jobs/post.ts": ENDPOINT("{ name: string }"),
    });
    expect(await send("/reports")).toEqual({
      status: 400,
      body: { error: { code: "VALIDATION_ERROR", message: "Invalid query", details: [{ field: "orgId", message: "Is required" }] } },
    });
    expect((await send("/reports?orgId=o1&utm_source=x")).body).toEqual({ items: { orgId: "o1" }, raw: "x" });
    expect((await send("/jobs?name=x", { method: "POST", body: "{}" })).body).toEqual({ items: {}, raw: null });
  });

  test("validation runs after the pre-hooks and before the handler", async () => {
    const send = await serve({
      "hooks/blocked.ts":
        'import { definePreHook, HttpError } from "@quickservicets/core";\nexport default definePreHook((_, req) => { if (req.headers.get("x-allow") !== "yes") throw new HttpError(403, "Blocked"); });',
      "endpoints/reports/get.ts": `import type { Endpoint } from "@quickservicets/core";
/** @blocked */
const handler: Endpoint<{ limit: number }, unknown> = async () => { throw new Error("handler ran"); };
export default handler;
`,
    });
    expect((await send("/reports?limit=abc")).status).toBe(403);
    const invalid = await send("/reports?limit=abc", { headers: { "x-allow": "yes" } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.details).toEqual([{ field: "limit", message: "Must be a number" }]);
  });
});

test("req.queryItems is typed with the first generic", async () => {
  const root = createLinkedProject({ "quickservicets.config.ts": MEMORY_CONFIG });
  const check = join(root, "check.ts");
  writeFileSync(
    check,
    `import type { Endpoint } from "@quickservicets/core";
export const handler: Endpoint<{ limit?: number; tags: string[] }, number> = async (_, req) => {
  const limit: number | undefined = req.queryItems.limit;
  const first: string | undefined = req.queryItems.tags[0];
  // @ts-expect-error not a declared item
  void req.queryItems.other;
  return (limit ?? 0) + (first?.length ?? 0);
};
`,
  );
  const program = ts.createProgram([check], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    lib: ["lib.esnext.d.ts"],
    types: [],
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program, program.getSourceFile(check));
  expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))).toEqual([]);
});
