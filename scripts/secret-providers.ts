/**
 * The secret provider contract over the repository: every `packages/plugin-secrets-*` package exports, from its
 * `testing` entry, `createProvider` and `fixtures`, and its provider must pass `runSecretProviderContract`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SecretProvider } from "../packages/core/src/index.ts";
import type { SecretProviderFixtures } from "../packages/core/src/testing/index.ts";

/** A provider package of the repository, with what its `testing` entry exports. */
export interface SecretProviderPackage {
  name: string;
  createProvider: () => SecretProvider | Promise<SecretProvider>;
  fixtures: SecretProviderFixtures | (() => SecretProviderFixtures | Promise<SecretProviderFixtures>);
}

/** The folders of `packages/` named `plugin-secrets-*`, sorted. */
export function secretProviderFolders(root: string): string[] {
  const packages = join(root, "packages");
  if (!existsSync(packages)) return [];
  return readdirSync(packages, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("plugin-secrets-"))
    .map((entry) => join(packages, entry.name))
    .sort();
}

/** Imports a provider package's `testing` entry (its `exports["./testing"]`), failing naming what is missing. */
export async function loadSecretProviderPackage(dir: string): Promise<SecretProviderPackage> {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; exports?: Record<string, unknown> };
  const name = manifest.name ?? dir;
  const entry = manifest.exports?.["./testing"];
  const path = typeof entry === "string" ? entry : (entry as { import?: string; default?: string } | undefined)?.import ?? (entry as { default?: string } | undefined)?.default;
  if (typeof path !== "string") throw new Error(`${name}: package.json has no exports["./testing"] entry`);
  const module = (await import(join(dir, path))) as Partial<SecretProviderPackage>;
  if (typeof module.createProvider !== "function") throw new Error(`${name}: the testing entry does not export createProvider`);
  if (module.fixtures === undefined) throw new Error(`${name}: the testing entry does not export fixtures`);
  return { name, createProvider: module.createProvider, fixtures: module.fixtures };
}
