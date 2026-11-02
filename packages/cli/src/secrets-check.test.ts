import { expect, test } from "bun:test";
import { join } from "node:path";
import { createLinkedProject } from "./testing/project.ts";

const CONFIG = `import { defineConfig, defineSecretProvider, memoryAdapter, SecretNotFoundError, secret } from "@quickservicets/core";
const values: Record<string, string> = { "billing/token": "billing-token-value", "tenants/acme/db": "acme-db-value" };
const vault = defineSecretProvider({
  name: "vault",
  schemes: ["vault"],
  resolve(reference) {
    const value = values[reference.path];
    if (value === undefined) throw new SecretNotFoundError(reference);
    return { value, version: "7" };
  },
});
export default defineConfig({
  database: memoryAdapter(),
  secrets: { providers: [vault], retries: 0 },
  tenancy: { source: "config", strategy: "database", tenants: { acme: {}, globex: {} }, connection: secret("vault://tenants/{tenant}/db") },
  http: { services: { billing: { url: "https://billing.example.com", auth: { bearer: secret("vault://billing/token") } } } },
});
`;

const cli = join(import.meta.dir, "index.ts");
const run = (root: string, ...args: string[]) => {
  const result = Bun.spawnSync(["bun", cli, "secrets", "check", ...args], { cwd: root, env: { ...process.env, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
};

test("secrets check prints one line per reference, resolves {tenant} references with --tenant and exits 1 on a failure, never with a value", () => {
  const root = createLinkedProject({ "quickservicets.config.ts": CONFIG });
  const plain = run(root);
  expect(plain.code).toBe(0);
  expect(plain.out.trim().split("\n")).toEqual(["http.services.billing.auth.bearer vault://billing/token ok version 7"]);
  const acme = run(root, "--tenant", "acme");
  expect(acme.code).toBe(0);
  expect(acme.out).toContain("tenancy.connection vault://tenants/{tenant}/db ok version 7");
  const globex = run(root, "--tenant", "globex");
  expect(globex.code).toBe(1);
  expect(globex.out).toContain("tenancy.connection vault://tenants/{tenant}/db failed: not found");
  const json = run(root, "--tenant", "globex", "--json");
  const document = JSON.parse(json.out) as { ok: boolean; references: { path: string; reference: string; ok: boolean; reason?: string }[] };
  expect(document.references).toContainEqual({ path: "tenancy.connection", reference: "vault://tenants/{tenant}/db", ok: false, reason: "not found" });
  for (const output of [plain, acme, globex, json]) expect(`${output.out}${output.err}`).not.toMatch(/billing-token-value|acme-db-value/);
});
