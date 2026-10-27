import { expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { TestService } from "@quickservicets/cli/testing";

export const root = join(import.meta.dir, "..");

/** The project files of a folder (the example's by default), as `startTestService` takes them. */
export function projectFiles(dir = root): Record<string, string> {
  const files: Record<string, string> = { "quickservicets.config.ts": readFileSync(join(dir, "quickservicets.config.ts"), "utf8") };
  for (const folder of ["entities", "endpoints", "features", "lib"]) {
    let entries;
    try {
      entries = readdirSync(join(dir, folder), { recursive: true, withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile()) files[relative(dir, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), "utf8");
    }
  }
  return files;
}

const post = (headers: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ title: "Hello" }) });

/** The example's checks: 401, 403, success, GET /me and the OpenAPI marks. */
export async function checkExample(service: TestService): Promise<void> {
  const anonymous = await service.fetch("/posts", post({}));
  expect(anonymous.status).toBe(401);
  expect(await anonymous.json()).toEqual({ error: { code: "UNAUTHORIZED", message: "Authentication required" } });
  expect((await service.fetch("/posts", post({ "x-test-user": "reader" }))).status).toBe(403);
  expect((await service.fetch("/posts", post({ "x-api-key": "k-123" }))).status).toBe(201);
  expect((await service.fetch("/posts", { headers: { "x-test-user": "reader" } })).status).toBe(200);
  expect((await service.fetch("/posts", { headers: { "x-api-key": "wrong" } })).status).toBe(401);
  expect(await (await service.fetch("/me", { headers: { "x-api-key": "k-123" } })).json()).toEqual({ id: "api-client", roles: ["editor"], claims: {} });
  expect((await service.fetch("/me")).status).toBe(401);
  const doc = (await (await service.fetch("/openapi.json")).json()) as { paths: Record<string, Record<string, { "x-auth"?: unknown; security?: unknown }>> };
  expect(doc.paths["/posts"]!.post!["x-auth"]).toEqual({ roles: ["editor"] });
  expect(doc.paths["/posts"]!.get!["x-auth"]).toEqual({});
  expect(doc.paths["/posts"]!.get!.security).toEqual([{ apiKey: [] }]);
}
