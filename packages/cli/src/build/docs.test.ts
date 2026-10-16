import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp, loadConfig, memoryAdapter, resolveConfig, SCALAR_URL } from "@quickservice/core";
import { createLinkedProject, MEMORY_CONFIG } from "../testing/project.ts";
import { build } from "./build.ts";

const project = (files: Record<string, string> = {}) =>
  createLinkedProject({
    "quickservice.config.ts": MEMORY_CONFIG,
    "package.json": JSON.stringify({ name: "acme-api", version: "2.0.0" }),
    "entities/User.ts": "export type User = { email: string }",
    ...files,
  });

async function serve(root: string, config: { production?: boolean; docs?: { enabled?: boolean } } = {}) {
  await build(root);
  const generated = join(root, ".generated");
  const { models } = await import(join(generated, "models.ts"));
  const { crudRoutes, endpoints, hooks } = await import(join(generated, "routes.ts"));
  const openApi = JSON.parse(readFileSync(join(generated, "openapi.json"), "utf8"));
  const database = memoryAdapter();
  await database.connect(models);
  const resolved = resolveConfig({ database, logger: { info() {}, warn() {}, error() {} }, ...config }, {});
  const { server } = createApp({ models, crudRoutes, endpoints, hooks, config: resolved, openApi });
  return { server, openApi };
}

describe("build output", () => {
  test("writes .generated/openapi.json with the document", async () => {
    const root = project();
    await build(root);
    const document = JSON.parse(readFileSync(join(root, ".generated/openapi.json"), "utf8"));
    expect(document.openapi).toBe("3.1.0");
    expect(document.info).toEqual({ title: "acme-api", version: "2.0.0" });
    expect(document.paths).toHaveProperty("/users");
    expect(readFileSync(join(root, ".generated/server.ts"), "utf8")).toContain('import openApi from "./openapi.json"');
  });
});

describe("routes", () => {
  test("serve the document and the Scalar page when enabled", async () => {
    const { server, openApi } = await serve(project());
    const json = await server.fetch(new Request("http://x/openapi.json"));
    expect(json.status).toBe(200);
    expect(json.headers.get("content-type")).toBe("application/json");
    expect(await json.json()).toEqual(openApi);
    const page = await server.fetch(new Request("http://x/docs"));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await page.text();
    expect(html).toContain(`<script src="${SCALAR_URL}"></script>`);
    expect(SCALAR_URL).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/npm\/@scalar\/api-reference@\d+\.\d+\.\d+$/);
    expect(html).toContain('data-url="/openapi.json"');
    expect(html).toContain("<title>acme-api API</title>");
  });

  test("respond 404 in production unless enabled", async () => {
    const root = project();
    const off = await serve(root, { production: true });
    for (const path of ["/openapi.json", "/docs"]) {
      const response = await off.server.fetch(new Request(`http://x${path}`));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: { code: "NOT_FOUND", message: "Route not found" } });
    }
    const on = await serve(root, { production: true, docs: { enabled: true } });
    expect((await on.server.fetch(new Request("http://x/docs"))).status).toBe(200);
  });

  test("are not in the document and run no hooks", async () => {
    const root = project({
      "hooks/blocked.ts":
        'import { definePreHook, HttpError } from "@quickservice/core";\nexport default definePreHook(() => { throw new HttpError(403, "Blocked"); });',
      "entities/User.ts": "/** @blocked */\nexport type User = { email: string }",
    });
    const { server, openApi } = await serve(root);
    expect(Object.keys(openApi.paths)).not.toContain("/docs");
    expect(Object.keys(openApi.paths)).not.toContain("/openapi.json");
    expect((await server.fetch(new Request("http://x/users"))).status).toBe(403);
    expect((await server.fetch(new Request("http://x/docs"))).status).toBe(200);
  });

  test("the page escapes the title", async () => {
    const { server } = await serve(project({ "package.json": JSON.stringify({ name: "<b>&", version: "1.0.0" }) }));
    expect(await (await server.fetch(new Request("http://x/docs"))).text()).toContain("<title>&lt;b&gt;&amp; API</title>");
  });
});

describe("reserved paths", () => {
  test("an entity routed at /docs fails the build", async () => {
    const root = project({ "entities/Doc.ts": "export type Doc = { title: string }" });
    await expect(build(root)).rejects.toThrow("entities/Doc.ts: route /docs uses /docs, which is reserved for the API docs");
    const named = project({ "entities/Page.ts": "/** @collection docs */\nexport type Page = { title: string }" });
    await expect(build(named)).rejects.toThrow("entities/Page.ts: route /docs uses /docs");
    const scoped = project({ "entities/docs/Page.ts": "export type Page = { title: string }" });
    await expect(build(scoped)).rejects.toThrow("entities/docs/Page.ts: route /docs/pages uses /docs");
  });

  test("custom GET /docs and GET /openapi.json fail the build", async () => {
    await expect(build(project({ "endpoints/docs/get.ts": "export default () => ({});" }))).rejects.toThrow(
      "endpoints/docs/get.ts: GET /docs is reserved for the API docs",
    );
    await expect(build(project({ "endpoints/openapi.json/get.ts": "export default () => ({});" }))).rejects.toThrow(
      "endpoints/openapi.json/get.ts: GET /openapi.json is reserved for the API docs",
    );
  });
});

describe("config", () => {
  test("docs.enabled defaults to the opposite of production", async () => {
    const database = memoryAdapter();
    expect(resolveConfig({ database }, {}).docs).toEqual({ enabled: true });
    expect(resolveConfig({ database }, { NODE_ENV: "production" }).docs).toEqual({ enabled: false });
    expect(resolveConfig({ database, production: true, docs: { enabled: true } }, {}).docs).toEqual({ enabled: true });
    const root = project();
    expect((await loadConfig(root, {})).docs.enabled).toBe(true);
    expect((await loadConfig(root, { NODE_ENV: "production" })).docs.enabled).toBe(false);
  });
});
