import { defineSecretProvider, SecretNotFoundError, type SecretReference } from "../public.ts";
import type { SecretProvider } from "./api.ts";

/** What a test entry holds: a text, or several keyed texts like a key-value vault secret. */
export type TestSecretValue = string | { values: Readonly<Record<string, string>> };

/** A provider for tests, backed by a map from reference path to value, with rotation, failures and a call log. */
export interface TestSecretProvider extends SecretProvider {
  readonly name: string;
  /** Every resolution asked for, in order: the reference text. */
  readonly calls: string[];
  /** Stores a new version of the secret at `path`, as a vault rotation does. */
  set(path: string, value: TestSecretValue): void;
  /** Makes resolutions of `path` fail with `error` (the next ones, until `set` or `heal`). */
  fail(path: string, error: Error): void;
  /** Stops failing `path`. */
  heal(path: string): void;
}

/**
 * A provider for the scheme `test` (or `scheme`) backed by `entries`, a map from reference path to a text or
 * `{ values }`; each `set` adds a version (the first is `1`), `?version=<n>` reads that one, and a missing path or
 * version fails with `SecretNotFoundError`. Provider, tenancy and project tests share it as their test double.
 */
export function testSecretProvider(entries: Readonly<Record<string, TestSecretValue>> = {}, scheme = "test"): TestSecretProvider {
  const versions = new Map<string, TestSecretValue[]>(Object.entries(entries).map(([path, value]) => [path, [value]]));
  const failures = new Map<string, Error>();
  const calls: string[] = [];
  const provider = defineSecretProvider({
    name: `test-${scheme}`,
    schemes: [scheme],
    resolve(reference: SecretReference, { signal }) {
      calls.push(reference.text);
      if (signal.aborted) throw signal.reason;
      const failure = failures.get(reference.path);
      if (failure) throw failure;
      const history = versions.get(reference.path);
      if (!history) throw new SecretNotFoundError(reference);
      const index = reference.version === undefined ? history.length - 1 : Number(reference.version) - 1;
      const value = Number.isInteger(index) ? history[index] : undefined;
      if (value === undefined) throw new SecretNotFoundError(reference);
      const version = String(index + 1);
      return typeof value === "string" ? { value, version } : { values: { ...value.values }, version };
    },
    health() {},
    close() {},
  });
  return Object.assign(provider, {
    calls,
    set(path: string, value: TestSecretValue) {
      failures.delete(path);
      versions.set(path, [...(versions.get(path) ?? []), value]);
    },
    fail: (path: string, error: Error) => void failures.set(path, error),
    heal: (path: string) => void failures.delete(path),
  }) as TestSecretProvider;
}
