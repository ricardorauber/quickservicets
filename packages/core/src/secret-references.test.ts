import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryAdapter } from "./adapters/memory.ts";
import { postgresAdapter } from "./adapters/postgres.ts";
import { ConfigError, resolveConfig, type ServiceConfig } from "./config.ts";
import { env } from "./env-vars.ts";
import { defineFeature, registerProjectFeatures, type FeatureDefinition } from "./features.ts";
import type { SecretProvider } from "./features/secrets/index.ts";
import { createFeatureLifecycle } from "./lifecycle.ts";
import type { LogEntry, Logger } from "./logger.ts";
import { object, secret } from "./options.ts";
import { isSecretReference, parseSecretReference, SecretReference, secretValue } from "./secret-references.ts";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "qs-secrets-"));
  writeFileSync(join(dir, "stripe"), "sk_test_123\n");
  writeFileSync(join(dir, "x.json"), JSON.stringify({ user: "app_user", password: "pa55word!" }));
  writeFileSync(join(dir, "plain"), "not json");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => registerProjectFeatures([]));

const captured = () => {
  const entries: LogEntry[] = [];
  const logger: Logger = { info: (entry) => void entries.push(entry), warn: (entry) => void entries.push(entry), error: (entry) => void entries.push(entry), debug: () => {} };
  return { entries, logger };
};

/** Resolves the config and runs every feature's setup, as a starting service does before connecting. */
async function start(config: ServiceConfig, environment: Record<string, string> = {}, features: FeatureDefinition[] = []) {
  registerProjectFeatures(features.map((definition) => ({ folder: definition.key, definition })));
  const { entries, logger } = captured();
  const resolved = resolveConfig({ database: memoryAdapter(), http: false, logger, ...config }, environment);
  const lifecycle = createFeatureLifecycle({ features: resolved.features, config: resolved, models: [], worker: { index: 0, count: 1, runsScheduledWork: true } });
  await lifecycle.setup();
  return { config: resolved, lifecycle, entries };
}

const failure = async (run: () => Promise<unknown>): Promise<Error> => {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure");
};

/** A provider for `test://` backed by a map, counting its calls. */
function testProvider(values: Record<string, string>, scheme = "test"): SecretProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    schemes: [scheme],
    calls,
    resolve(reference) {
      calls.push(reference.text);
      const value = values[reference.path];
      if (value === undefined) throw new Error(`${reference.text}: not found`);
      return { value, version: "1" };
    },
  };
}

/** A project feature registering `provider` with the secrets native during its setup. */
const providerFeature = (provider: SecretProvider, key = "vault-test") =>
  defineFeature({ key, enabledByDefault: true, requires: ["secrets"], setup: (ctx) => ctx.feature("secrets").provider(provider) });

describe("reference parsing and the secret overload", () => {
  test("secret(text) parses scheme, path, key and version; secret() stays the option builder", () => {
    const reference = secret("vault://kv/db#url?version=3");
    expect(reference).toBeInstanceOf(SecretReference);
    expect(reference).toMatchObject({ scheme: "vault", path: "kv/db", key: "url", version: "3", text: "vault://kv/db#url?version=3" });
    expect(isSecretReference(reference)).toBe(true);
    expect(parseSecretReference("file:///run/secrets/stripe")).toMatchObject({ scheme: "file", path: "/run/secrets/stripe" });
    expect(parseSecretReference("env://PG_URL").key).toBeUndefined();
    expect(secret().kind).toBe("secret");
  });

  test("text that is not a reference throws naming it", () => {
    expect(() => secret("nope")).toThrow("Invalid secret reference nope: expected <scheme>://<path>[#<key>][?version=<version>]");
    expect(() => secret("Vault://kv/db")).toThrow('Invalid secret reference Vault://kv/db: the scheme "Vault" must match');
    expect(() => secret("vault://")).toThrow("Invalid secret reference vault://: the path is empty");
    expect(() => secret("vault://kv#")).toThrow("the key after # is empty");
    expect(() => secret("vault://kv?ttl=3")).toThrow("the only query is ?version=<version>");
  });
});

describe("accepted locations and replacement after resolution", () => {
  test("a declared secret variable holding file:// resolves into env, masked in logs", async () => {
    const logs = defineFeature({
      key: "audit-log",
      enabledByDefault: true,
      setup: (ctx) => ctx.logger.info({ timestamp: new Date().toISOString(), message: "key.read", detail: `key=${(env as Record<string, unknown>).STRIPE_KEY as string}` }),
    });
    const { entries } = await start({ secrets: {}, env: { STRIPE_KEY: secret() } }, { STRIPE_KEY: `file://${join(dir, "stripe")}` }, [logs]);
    expect((env as Record<string, unknown>).STRIPE_KEY).toBe("sk_test_123");
    expect(JSON.stringify(env)).toContain('"STRIPE_KEY":"[secret]"');
    const entry = entries.find((item) => item.message === "key.read")!;
    expect(entry.detail).toBe("key=[secret]");
  });

  test("feature options, server.tls and files are replaced in place and print masked", async () => {
    const consumer = defineFeature({ key: "billing", options: object({ apiKey: secret() }) });
    const { config } = await start(
      { secrets: {}, billing: { apiKey: secret(`file://${join(dir, "x.json")}#password`) }, files: { signingSecret: secret("env://SIGNING") } } as ServiceConfig,
      { SIGNING: "signing-secret-1" },
      [consumer],
    );
    const options = config.features.find((feature) => feature.key === "billing")!.options as unknown as { apiKey: string };
    expect(options.apiKey).toBe("pa55word!");
    expect(JSON.stringify(options)).toBe('{"apiKey":"[secret]","enabled":true}');
    expect(config.files.signingSecret).toBe("signing-secret-1");
    expect(JSON.stringify(config.files)).toContain('"signingSecret":"[secret]"');
  });

  test("server.tls references are resolved on a copy, never on the project's config object", async () => {
    const tls = { cert: secret("env://CERT"), key: secret("env://KEY"), passphrase: secret("env://PASS") };
    const { config } = await start({ secrets: {}, server: { tls } }, { CERT: "cert-pem-text", KEY: "key-pem-text", PASS: "passphrase-1" });
    expect(config.server.tls).toMatchObject({ cert: "cert-pem-text", key: "key-pem-text", passphrase: "passphrase-1" });
    expect(JSON.stringify(config.server.tls)).toBe('{"cert":"[secret]","key":"[secret]","passphrase":"[secret]"}');
    expect(isSecretReference(tls.key)).toBe(true);
  });

  test("adapters keep their reference and read the value through secretValue", async () => {
    const adapter = postgresAdapter({ url: secret("env://PG_URL") });
    await start({ secrets: {}, database: adapter }, { PG_URL: "postgres://app:pw-123456@localhost:5432/app" });
    expect(adapter.secretReferences!().map((reference) => reference.text)).toEqual(["env://PG_URL"]);
    expect(secretValue(adapter.secretReferences!()[0]!)).toBe("postgres://app:pw-123456@localhost:5432/app");
  });

  const pgUrl = process.env.TEST_POSTGRES_URL;
  test.skipIf(!pgUrl)("postgresAdapter({ url: secret(\"env://PG_URL\") }) connects with the URL in PG_URL", async () => {
    const adapter = postgresAdapter({ url: secret("env://PG_URL") });
    const { config } = await start({ secrets: {}, database: adapter }, { PG_URL: pgUrl! });
    await config.database.connect([]);
    try {
      const rows = await adapter.client!`select 1 as one`;
      expect(rows[0].one).toBe(1);
    } finally {
      await config.database.disconnect();
    }
  });
});

describe("provider registration, reserved schemes and ordering", () => {
  test("a feature using secrets is set up first, and the later feature's setup reads the resolved value", async () => {
    let seen: unknown;
    // The consumer's folder sorts before the provider's, so only the ordering puts the provider first.
    const consumer = defineFeature({ key: "a-consumer", options: object({ token: secret() }), setup: (ctx) => void (seen = ctx.options.token) });
    const provider = testProvider({ api: JSON.stringify({ token: "tok-abcdef-123" }) });
    const { config } = await start({ secrets: {}, "a-consumer": { token: secret("test://api#token") } } as ServiceConfig, {}, [consumer, providerFeature(provider, "z-vault")]);
    expect(config.features.map((feature) => feature.key).filter((key) => ["secrets", "z-vault", "a-consumer"].includes(key))).toEqual(["secrets", "z-vault", "a-consumer"]);
    expect(seen).toBe("tok-abcdef-123");
  });

  test("registering a reserved or taken scheme fails startup naming it", async () => {
    const https = await failure(() => start({ secrets: {} }, {}, [providerFeature(testProvider({}, "https"))]));
    expect(https.message).toContain("The secret scheme https is reserved for connection URLs");
    const twice = await failure(() => start({ secrets: {} }, {}, [providerFeature(testProvider({}, "env"))]));
    expect(twice.message).toContain("The secret scheme env is registered twice");
    const invalid = await failure(() => start({ secrets: {} }, {}, [providerFeature(testProvider({}, "Bad"))]));
    expect(invalid.message).toContain('Invalid secret scheme "Bad"');
  });
});

describe("built-in providers and JSON keys", () => {
  test("env:// reads the variable and fails when it is unset; file:// strips one trailing line break", async () => {
    const consumer = defineFeature({ key: "billing", options: object({ a: secret(), b: secret().optional() }) });
    const { config } = await start({ secrets: {}, billing: { a: secret("env://A_KEY"), b: secret(`file://${join(dir, "stripe")}`) } } as ServiceConfig, { A_KEY: "value-of-a" }, [consumer]);
    expect(config.features.find((feature) => feature.key === "billing")!.options).toMatchObject({ a: "value-of-a", b: "sk_test_123" });
    const missing = await failure(() => start({ secrets: {}, billing: { a: secret("env://A_KEY") } } as ServiceConfig, {}, [consumer]));
    expect(missing.message).toContain("billing.a: env://A_KEY (the variable A_KEY is not set)");
  });

  test("#key reads a JSON property and fails without JSON or the key", async () => {
    const consumer = defineFeature({ key: "billing", options: object({ a: secret() }) });
    const user = await start({ secrets: {}, billing: { a: secret(`file://${join(dir, "x.json")}#user`) } } as ServiceConfig, {}, [consumer]);
    expect(user.config.features.find((feature) => feature.key === "billing")!.options).toMatchObject({ a: "app_user" });
    const missingKey = await failure(() => start({ secrets: {}, billing: { a: secret(`file://${join(dir, "x.json")}#missing`) } } as ServiceConfig, {}, [consumer]));
    expect(missingKey.message).toContain("(no key missing)");
    const notJson = await failure(() => start({ secrets: {}, billing: { a: secret(`file://${join(dir, "plain")}#user`) } } as ServiceConfig, {}, [consumer]));
    expect(notJson.message).toContain("(the value is not JSON)");
  });
});

describe("timeouts, retries, the startup error and masking", () => {
  test("two failing references give one error with a line each and no values", async () => {
    const consumer = defineFeature({ key: "billing", options: object({ a: secret(), b: secret() }) });
    const provider = testProvider({ present: "the-present-value" });
    const error = await failure(() =>
      start({ secrets: { retries: 0 }, billing: { a: secret("test://missing-one"), b: secret("test://missing-two") } } as ServiceConfig, {}, [consumer, providerFeature(provider)]),
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toBe(["Cannot resolve secrets:", "  billing.a: test://missing-one (not found)", "  billing.b: test://missing-two (not found)"].join("\n"));
  });

  test("the same reference text is resolved once", async () => {
    const consumer = defineFeature({ key: "billing", options: object({ a: secret(), b: secret() }) });
    const provider = testProvider({ shared: "shared-value-1" });
    await start({ secrets: {}, billing: { a: secret("test://shared"), b: secret("test://shared") } } as ServiceConfig, {}, [consumer, providerFeature(provider)]);
    expect(provider.calls).toEqual(["test://shared"]);
  });

  test("a provider that never answers fails after the timeout and the retries", async () => {
    let calls = 0;
    let aborted = 0;
    const hanging: SecretProvider = {
      schemes: ["slow"],
      resolve: (_reference, { signal }) =>
        new Promise((_, reject) => {
          calls++;
          signal.addEventListener("abort", () => (aborted++, reject(signal.reason)));
        }),
    };
    const consumer = defineFeature({ key: "billing", options: object({ a: secret() }) });
    const started = Date.now();
    const error = await failure(() => start({ secrets: { timeout: "50ms", retries: 2 }, billing: { a: secret("slow://x") } } as ServiceConfig, {}, [consumer, providerFeature(hanging)]));
    expect(error.message).toBe("Cannot resolve secrets:\n  billing.a: slow://x (timed out after 50 ms)");
    expect(calls).toBe(3);
    expect(aborted).toBe(3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });

  test("a reference with the native off fails naming the path, and resolved values print masked", async () => {
    const consumer = defineFeature({ key: "billing", options: object({ a: secret() }) });
    registerProjectFeatures([{ folder: "billing", definition: consumer }]);
    expect(() => resolveConfig({ database: memoryAdapter(), billing: { a: secret("env://A") } } as ServiceConfig, {})).toThrow("billing.a uses env://A; add secrets: {} to quickservicets.config.ts");
    expect(() => resolveConfig({ database: postgresAdapter({ url: secret("env://PG_URL") }) }, {})).toThrow("database.url uses env://PG_URL; add secrets: {} to quickservicets.config.ts");
    const { config } = await start({ secrets: {}, billing: { a: secret("env://A") } } as ServiceConfig, { A: "resolved-value-a" }, [consumer]);
    expect(JSON.stringify(config.features.find((feature) => feature.key === "billing")!.options)).not.toContain("resolved-value-a");
    expect(JSON.stringify(config.features.find((feature) => feature.key === "billing")!.options)).toContain("[secret]");
  });
});
