import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { testAuth } from "@quickservicets/core/testing";
import { startTestService } from "@quickservicets/cli/testing";

const root = join(import.meta.dir, "..");

/** The example's own files, as `startTestService` takes them. */
function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = { "quickservicets.config.ts": readFileSync(join(root, "quickservicets.config.ts"), "utf8") };
  for (const folder of ["entities", "endpoints", "features", "lib"]) {
    for (const entry of readdirSync(join(root, folder), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files[relative(root, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), "utf8");
    }
  }
  return files;
}

const me = async (response: Response) => (await response.json()) as { user: { id: string; roles: string[] } | null; method: string | null };

test("the project's API key provider signs in an editor, and a wrong key answers 401", async () => {
  const service = await startTestService({ files: exampleFiles(), env: { API_KEY: "k-123" } });
  try {
    expect(await me(await service.fetch("/me"))).toEqual({ user: null, method: null });
    expect(await me(await service.fetch("/me", { headers: { "x-api-key": "k-123" } }))).toEqual({ user: { id: "api-client", roles: ["editor"], claims: {} } as never, method: "apiKey" });
    const refused = await service.fetch("/me", { headers: { "x-api-key": "nope" } });
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toBe('ApiKey header="x-api-key"');
    expect(await refused.json()).toEqual({ error: { code: "UNAUTHORIZED", message: "Invalid credentials" } });
  } finally {
    await service.stop();
  }
});

test("testAuth() signs in any test user", async () => {
  const service = await startTestService({ files: exampleFiles(), auth: testAuth() });
  try {
    const seen = await me(await service.fetch("/me", { headers: { "x-test-user": "u1;roles=admin" } }));
    expect(seen).toEqual({ user: { id: "u1", roles: ["admin"], claims: {} } as never, method: "test" });
  } finally {
    await service.stop();
  }
});
