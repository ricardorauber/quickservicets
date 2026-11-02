import {
  clearStoredSecrets,
  ConfigError,
  configSecretReferences,
  defineFeature,
  duration,
  integer,
  object,
  parseDuration,
  parseSecretReference,
  replaceEnvValue,
  RESOLVE_STARTUP_SECRETS,
  secretVariables,
  storeSecretValue,
  type FeatureSetupContext,
  type ReferenceLocation,
} from "../public.ts";
import type { SecretProvider, SecretsApi } from "./api.ts";
import { builtInProviders, providerRegistry, reasonOf, resolveReference, type ProviderRegistry, type ResolvedSecret } from "./resolve.ts";

export type { SecretProvider, SecretResolution, SecretResolveContext, SecretsApi } from "./api.ts";
export { providerRegistry, resolveReference, schemeProblem } from "./resolve.ts";

const options = object({
  timeout: duration().default("10s").describe("The longest each attempt to resolve a reference may take."),
  retries: integer().min(0).default(2).describe("How many times a failed resolution is retried, with backoff, before startup fails."),
});

/** The text a declared secret variable holds when it is a reference: a registered scheme followed by `://`. */
const REFERENCE_TEXT = /^([a-z][a-z0-9-]*):\/\//;

/** The references of the configuration and of the declared secret variables that hold one, with their paths. */
function startupReferences(ctx: FeatureSetupContext, registry: ProviderRegistry, problems: string[]): ReferenceLocation[] {
  const found = configSecretReferences(ctx.config);
  for (const { name, value } of secretVariables()) {
    if (typeof value !== "string") continue;
    const scheme = REFERENCE_TEXT.exec(value)?.[1];
    if (scheme === undefined || !registry.has(scheme)) continue;
    try {
      found.push({ path: `env.${name}`, reference: parseSecretReference(value), replace: (resolved) => replaceEnvValue(name, resolved) });
    } catch (error) {
      problems.push(`env.${name}: ${(error as Error).message}`);
    }
  }
  return found;
}

/**
 * Resolves every reference once (the same text once), puts each value in place of its references and makes it a known
 * secret value; fails with one `ConfigError` listing every failure, never a value.
 */
async function resolveAtStartup(ctx: FeatureSetupContext<{ timeout: string; retries: number }>, registry: ProviderRegistry): Promise<void> {
  const problems: string[] = [];
  // A service starting again in this process resolves its references anew.
  clearStoredSecrets();
  const locations = startupReferences(ctx, registry, problems);
  const settings = { timeout: parseDuration(ctx.options.timeout) ?? 10_000, retries: ctx.options.retries };
  const pending = new Map<string, Promise<ResolvedSecret>>();
  for (const location of locations) {
    const { reference } = location;
    if (!pending.has(reference.text)) pending.set(reference.text, resolveReference(registry, reference, settings));
  }
  const results = new Map<string, { ok: true; secret: ResolvedSecret } | { ok: false; reason: string }>();
  await Promise.all(
    [...pending].map(async ([text, work]) => {
      try {
        results.set(text, { ok: true, secret: await work });
      } catch (error) {
        results.set(text, { ok: false, reason: reasonOf(locations.find((location) => location.reference.text === text)!.reference, error) });
      }
    }),
  );
  for (const location of locations) {
    const result = results.get(location.reference.text)!;
    if (!result.ok) problems.push(`${location.path}: ${location.reference.text} (${result.reason})`);
  }
  if (problems.length > 0) throw new ConfigError(["Cannot resolve secrets:", ...problems.map((line) => `  ${line}`)].join("\n"));
  for (const [text, result] of results) if (result.ok) storeSecretValue(text, { value: result.secret.value, ...(result.secret.version !== undefined ? { version: result.secret.version } : {}) });
  for (const location of locations) {
    const result = results.get(location.reference.text)!;
    if (result.ok) location.replace?.(result.secret.value);
  }
}

/**
 * The `secrets` native: any secret value of the configuration (options, declared variables, adapter credentials,
 * certificate keys) may be a reference like `secret("vault://kv/db#url")`, resolved once at startup by the provider of
 * its scheme, before every other feature sets up and the database connects. `env://` and `file://` are built in;
 * features register providers for other schemes. Off unless `secrets: {}` (or `QS_SECRETS_ENABLED=true`) is set, or a
 * feature enables it.
 */
const secretsFeature = defineFeature({
  key: "secrets",
  docs: {
    summary: "Secret references like secret(\"vault://kv/db#url\") in the configuration, resolved at startup by pluggable providers, with built-in env:// and file:// providers.",
    sections: [
      {
        title: "References",
        text: [
          "A reference is `<scheme>://<path>[#<key>][?version=<version>]`, written as `secret(\"env://STRIPE_KEY\")` in `quickservicets.config.ts`. It is accepted by every `secret()` option of the config and of the features, by `server.tls.cert`, `key` and `passphrase`, by `files.signingSecret`, and by the `url` of `postgresAdapter` and `mongodbAdapter`. A declared variable of kind `secret()` whose text starts with a registered scheme and `://`, like `STRIPE_KEY=file:///run/secrets/stripe`, is a reference too.",
          "",
          "`env://NAME` reads the variable (unset or empty fails), and `file://<path>` the file's content without one trailing line break (`file:///abs/path` for an absolute path, otherwise relative to the working directory). `#<key>` reads that property of the value parsed as JSON.",
        ].join("\n"),
      },
      {
        title: "Startup",
        text: [
          "The native and the features that list `secrets` in `requires` or `enables` set up first; then every reference is resolved, each text once, with `timeout` per attempt and `retries` retries. Other features, adapters and `env` only see values. Failures stop startup with one error starting `Cannot resolve secrets:` and one line per failure, `<config path>: <reference> (<reason>)`, never a value.",
          "",
          "Resolved values are masked as `[secret]` in logs, errors, reports and printed configs. A reference while the native is off fails with `<path> uses <reference>; add secrets: {} to quickservicets.config.ts`.",
        ].join("\n"),
      },
    ],
  },
  options,
  api: (ctx): SecretsApi & { [RESOLVE_STARTUP_SECRETS]: () => Promise<void> } => {
    const registry = providerRegistry();
    for (const provider of builtInProviders()) registry.add(provider, "secrets");
    ctx.app.onStop(async () => {
      for (const provider of registry.all()) await provider.close?.();
    });
    return {
      provider: (provider: SecretProvider) => registry.add(provider, ctx.currentFeature() ?? "a feature"),
      [RESOLVE_STARTUP_SECRETS]: () => resolveAtStartup(ctx as never, registry),
    };
  },
});

export { secretsFeature };
export default secretsFeature;
