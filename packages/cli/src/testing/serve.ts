import { join } from "node:path";
import { createApp, importConfigFile, resolveConfig, type App } from "@quickservicets/core";

/** Starts the app a built project generated, in this process, on its configured database; for tests. */
export async function serveBuilt(root: string, env: Record<string, string | undefined> = {}): Promise<App & { get(path: string): Promise<{ status: number; body: any }>; request(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> }> {
  const generated = join(root, ".generated");
  const { models } = (await import(join(generated, "models.ts"))) as { models: never[] };
  const routes = (await import(join(generated, "routes.ts"))) as { crudRoutes: never[]; endpoints: never[]; hooks: Map<string, never> };
  const { jobs } = (await import(join(generated, "jobs.ts"))) as { jobs: Map<string, never> };
  const { featureFolders } = (await import(join(generated, "features.ts"))) as { featureFolders: Record<string, Record<string, Map<string, unknown>>> };
  const openApi = (await import(join(generated, "openapi.json"))).default as { info?: { title?: string } };
  const projectConfig = await importConfigFile(root);
  const config = resolveConfig({ logger: { info() {}, warn() {}, error() {} }, ...projectConfig }, env, root);
  await config.database.connect(models, { defaultSchema: config.schema });
  const app = createApp({ models, crudRoutes: routes.crudRoutes, endpoints: routes.endpoints, hooks: routes.hooks, config, openApi, jobs, featureFolders });
  const request = async (method: string, path: string, body?: unknown) => {
    const init: RequestInit = body === undefined ? { method } : { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } };
    const response = await app.server.fetch(new Request(`http://localhost${path}`, init));
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  return { ...app, request, get: (path) => request("GET", path) };
}
