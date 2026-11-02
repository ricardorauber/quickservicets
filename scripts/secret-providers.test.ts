import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSecretProvider, runSecretProviderContract } from "../packages/core/src/testing/index.ts";
import { loadSecretProviderPackage, secretProviderFolders } from "./secret-providers.ts";

const repository = join(import.meta.dir, "..");
const folders = secretProviderFolders(repository);
const packages = await Promise.all(folders.map((dir) => loadSecretProviderPackage(dir)));

describe("the secret provider packages", () => {
  test("every packages/plugin-secrets-* package is found (none is fine)", () => {
    expect(Array.isArray(folders)).toBe(true);
  });
  for (const loaded of packages) runSecretProviderContract(loaded.createProvider, { name: loaded.name, fixtures: loaded.fixtures });
});

const scratch = mkdtempSync(join(tmpdir(), "qs-secret-providers-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("a package whose provider leaks", () => {
  test("a provider putting the value in an error message fails the contract", async () => {
    const dir = join(scratch, "packages/plugin-secrets-x");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@quickservicets/plugin-secrets-x", exports: { ".": "./src/index.ts", "./testing": "./src/testing.ts" } }));
    const core = JSON.stringify(join(repository, "packages/core/src/index.ts"));
    writeFileSync(
      join(dir, "src/testing.ts"),
      [
        `import { defineSecretProvider, SecretAccessError } from ${core};`,
        `const values: Record<string, string> = { db: "leaked-secret-value", "db-v2": "second-version-value" };`,
        `export const createProvider = () => defineSecretProvider({`,
        `  name: "x",`,
        `  schemes: ["x"],`,
        `  resolve(reference) {`,
        `    if (reference.path === "denied") throw new SecretAccessError(reference);`,
        `    if (reference.version) return { value: values["db-v2"]!, version: reference.version };`,
        `    const value = values[reference.path];`,
        `    if (value === undefined) throw new Error(reference.text + ": not found (the vault holds " + values.db + ")");`,
        `    return reference.key ? { values: { user: value } } : { value };`,
        `  },`,
        `});`,
        `export const fixtures = {`,
        `  value: { reference: "x://db", value: "leaked-secret-value" },`,
        `  key: { reference: "x://db#user", value: "leaked-secret-value" },`,
        `  version: { reference: "x://db?version=2", value: "second-version-value", version: "2" },`,
        `  missing: "x://missing",`,
        `  denied: "x://denied",`,
        `  slow: "x://slow",`,
        `};`,
      ].join("\n"),
    );
    expect(secretProviderFolders(scratch)).toEqual([dir]);
    const loaded = await loadSecretProviderPackage(dir);
    const failures = await checkSecretProvider(loaded.createProvider, { fixtures: loaded.fixtures });
    expect(failures.map((failure) => failure.check)).toContain("reports a missing secret with SecretNotFoundError, without values");
  });
});
