import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./index.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { env } from "./env-vars.ts";
import { defineFeature, registerProjectFeatures } from "./features.ts";
import type { SecretResolveFailure } from "./features/secrets/index.ts";
import { createFeatureLifecycle } from "./lifecycle.ts";
import { object, secret } from "./options.ts";
import { defineSecretProvider } from "./secret-references.ts";
import { testSecretProvider } from "./testing/index.ts";

const dir = mkdtempSync(join(tmpdir(), "qs-secrets-custom-"));
writeFileSync(join(dir, "stripe"), "sk_level_zero\n");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => registerProjectFeatures([]));

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

async function start(config: Record<string, unknown>, environment: Record<string, string> = {}) {
  const resolved = resolveConfig({ database: memoryAdapter(), http: false, ...config } as ServiceConfig, environment);
  const lifecycle = createFeatureLifecycle({ features: resolved.features, config: resolved, models: [], worker: { index: 0, count: 1, runsScheduledWork: true } });
  stops.push(() => lifecycle.stop());
  await lifecycle.setup();
  return resolved;
}

const consumer = defineFeature({ key: "billing", options: object({ token: secret() }) });
const tokenOf = (config: { features: { key: string; options: unknown }[] }) => (config.features.find((feature) => feature.key === "billing")!.options as { token: string }).token;

describe("variables and level 0", () => {
  test("secrets: {} resolves file:// with the defaults, and QS_SECRETS_TTL overrides the ttl", async () => {
    await start({ secrets: {}, env: { STRIPE_KEY: secret() } }, { STRIPE_KEY: `file://${join(dir, "stripe")}` });
    expect((env as Record<string, unknown>).STRIPE_KEY).toBe("sk_level_zero");
    const resolved = resolveConfig({ database: memoryAdapter(), secrets: {} }, { QS_SECRETS_TTL: "1m", QS_SECRETS_ON_REFRESH_ERROR: "fail", QS_SECRETS_TENANT_CACHE_SIZE: "5" });
    expect(resolved.features.find((feature) => feature.key === "secrets")!.options).toMatchObject({ ttl: "1m", onRefreshError: "fail", tenantCacheSize: 5, timeout: "10s", retries: 2 });
    expect(resolveConfig({ database: memoryAdapter() }, { QS_SECRETS_ENABLED: "true" }).features.some((feature) => feature.key === "secrets")).toBe(true);
  });
});

describe("hooks and project providers", () => {
  test("beforeResolve changes what the provider receives; onResolveFailed gets the reason without a value", async () => {
    const vault = testSecretProvider({ "kv/staging/db": "staging-db-token" }, "vault");
    registerProjectFeatures([{ folder: "billing", definition: consumer }]);
    const config = await start({
      secrets: { providers: [vault], beforeResolve: ({ reference }: { reference: string }) => reference.replace("vault://kv/", "vault://kv/staging/") },
      billing: { token: secret("vault://kv/db") },
    });
    expect(vault.calls).toEqual(["vault://kv/staging/db"]);
    expect(tokenOf(config)).toBe("staging-db-token");

    const failures: SecretResolveFailure[] = [];
    await expect(start({ secrets: { providers: [vault], retries: 0, onResolveFailed: (failure: SecretResolveFailure) => void failures.push(failure) }, billing: { token: secret("vault://kv/missing") } })).rejects.toThrow("Cannot resolve secrets:");
    expect(failures).toEqual([{ reference: "vault://kv/missing", path: "billing.token", reason: "not found" }]);
  });

  test("a project provider in providers resolves its scheme; one for https fails startup", async () => {
    registerProjectFeatures([{ folder: "billing", definition: consumer }]);
    const local = defineSecretProvider({ name: "local", schemes: ["local"], resolve: () => ({ values: { token: "partner-local-token" } }) });
    const config = await start({ secrets: { providers: [local] }, billing: { token: secret("local://partner#token") } });
    expect(tokenOf(config)).toBe("partner-local-token");
    const https = defineSecretProvider({ name: "web", schemes: ["web"], resolve: () => ({ value: "x" }) });
    await expect(start({ secrets: { providers: [{ ...https, schemes: ["https"] }] } })).rejects.toThrow("The secret scheme https is reserved for connection URLs");
  });
});

describe("reference content", () => {
  test("the reference page lists the variables, hooks, syntax, schemes, setup API and contract, and says there are no tags or files", () => {
    const page = readFileSync(join(import.meta.dir, "../../../docs/src/content/docs/reference/features/secrets.mdx"), "utf8");
    for (const text of ["QS_SECRETS_TTL", "QS_SECRETS_TENANT_CACHE_SIZE", "beforeResolve", "onRotate", "onResolveFailed", "<scheme>://<path>[#<key>][?version=<version>]", "env://NAME", "file://<path>", `ctx.feature("secrets").provider`, "defineSecretProvider", "No tags:", "No files:"]) {
      expect(page.includes(text) ? text : `missing ${text}`).toBe(text);
    }
  });
});
