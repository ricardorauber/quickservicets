import {
  clearStoredSecrets,
  ConfigError,
  configSecretReferences,
  defineFeature,
  duration,
  hook,
  integer,
  object,
  oneOf,
  parseDuration,
  parseSecretReference,
  reloadTlsValues,
  replaceEnvValue,
  RESOLVE_STARTUP_SECRETS,
  runAfterHooks,
  safeLog,
  secretVariables,
  setSecretsRuntime,
  storeSecretValue,
  type FeatureSetupContext,
  type ReferenceLocation,
  type SecretReference,
} from "../public.ts";
import type { SecretProvider, SecretsApi } from "./api.ts";
import { SecretCache, secretsNow, type CacheEntry, type SecretRotation } from "./cache.ts";
import { builtInProviders, providerRegistry, reasonOf, resolveReference, type ProviderRegistry, type ResolvedSecret } from "./resolve.ts";

export type { SecretProvider, SecretResolution, SecretResolveContext, SecretsApi } from "./api.ts";
export type { SecretRotation } from "./cache.ts";
export { dueTime, setSecretsClock } from "./cache.ts";
export { providerRegistry, resolveReference, schemeProblem } from "./resolve.ts";

const options = object({
  timeout: duration().default("10s").describe("The longest each attempt to resolve a reference may take."),
  retries: integer().min(0).default(2).describe("How many times a failed resolution is retried, with backoff, before startup fails."),
  ttl: duration().default("15m").describe("How long a value is kept before it is resolved again, when its provider gives no ttl or expiry."),
  refresh: duration().default("1m").describe("How often each worker checks for values that are due, re-resolving them in the background."),
  onRefreshError: oneOf(["keep", "fail"])
    .default("keep")
    .describe("What a failed refresh does: keep serves the last value, fail also fails the readiness check; both retry at the next check."),
  onRotate: hook<SecretRotation, undefined>().describe("Runs after a value changed, with the config path, the reference and the new version, never the value."),
});

type SecretsOptions = { timeout: string; retries: number; ttl: string; refresh: string; onRefreshError: "keep" | "fail"; onRotate: ((rotation: SecretRotation) => unknown)[] };

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

/** The cache of the running service, which `refreshSecrets()` checks. */
let active: SecretCache | undefined;

/**
 * Checks now for values that are due (as each worker does every `refresh`) and re-resolves them, resolving once the
 * pass ended; for tests with a fake clock and for operations that cannot wait.
 */
export function refreshSecrets(): Promise<void> {
  return active?.refreshDue() ?? Promise.resolve();
}

/**
 * Resolves every reference once (the same text once), puts each value in place of its references and keeps it in the
 * cache; fails with one `ConfigError` listing every failure, never a value.
 */
async function resolveAtStartup(ctx: FeatureSetupContext<SecretsOptions>, registry: ProviderRegistry, cache: SecretCache): Promise<void> {
  const problems: string[] = [];
  // A service starting again in this process resolves its references anew.
  clearStoredSecrets();
  const locations = startupReferences(ctx, registry, problems);
  const pending = new Map<string, Promise<ResolvedSecret>>();
  for (const location of locations) {
    const { reference } = location;
    if (!pending.has(reference.text)) pending.set(reference.text, resolveReference(registry, reference, resolveSettings(ctx.options)));
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
  for (const [text, result] of results) {
    if (!result.ok) continue;
    const used = locations.filter((location) => location.reference.text === text);
    cache.add(used[0]!.reference, result.secret, used);
    storeSecretValue(text, { value: result.secret.value, ...(result.secret.version !== undefined ? { version: result.secret.version } : {}) });
    for (const location of used) location.replace?.(result.secret.value);
  }
}

const resolveSettings = (options: SecretsOptions) => ({ timeout: parseDuration(options.timeout) ?? 10_000, retries: options.retries });

/** Applies a rotated value where it is used, then tells the hooks, the event bus, the log and the TLS server. */
async function rotated(ctx: FeatureSetupContext<SecretsOptions>, entry: CacheEntry): Promise<void> {
  const value = entry.value!;
  for (const location of entry.locations) location.replace?.(value);
  const eventsOn = ctx.config.features.some((feature) => feature.key === "events");
  for (const path of SecretCache.paths(entry)) {
    const rotation: SecretRotation = { path, reference: entry.reference.text, ...(entry.version !== undefined ? { version: entry.version } : {}) };
    safeLog(ctx.logger, "info", { timestamp: new Date(secretsNow()).toISOString(), message: "secrets.rotated", path, ...(entry.version !== undefined ? { version: entry.version } : {}) });
    try {
      if (ctx.options.onRotate.length > 0) await runAfterHooks(ctx.options.onRotate as never, rotation, undefined);
      if (eventsOn) await ctx.events.emit("secret.rotated", rotation);
    } catch (error) {
      safeLog(ctx.logger, "error", { timestamp: new Date(secretsNow()).toISOString(), message: "secrets.rotate.failed", path, error: { message: (error as Error)?.message ?? String(error) } });
    }
  }
}

/**
 * The `secrets` native: any secret value of the configuration (options, declared variables, adapter credentials,
 * certificate keys) may be a reference like `secret("vault://kv/db#url")`, resolved once at startup by the provider of
 * its scheme, before every other feature sets up and the database connects, and kept fresh while the service runs:
 * values are re-resolved in the background when their ttl or lease ends, and rotated values reach the config, `env`,
 * the HTTP client, new database connections and TLS without a restart. `env://` and `file://` are built in; features
 * register providers for other schemes. Off unless `secrets: {}` (or `QS_SECRETS_ENABLED=true`) is set, or a feature
 * enables it.
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
      {
        title: "Cache and rotation",
        text: [
          "Each value is due again at its provider's `ttl`, or at two thirds of the time until its `expiresAt`, whichever comes first (the `ttl` option when the provider gives neither). Every `refresh`, each worker re-resolves the due values in the background, never on the request path.",
          "",
          "A changed value replaces the old one in the config, the features' options and `env`, and behind `secretValue`; both stay masked. The `onRotate` hooks get `{ path, reference, version }` (never the value), `secret.rotated` is emitted with the same fields while `events` is on, and `secrets.rotated` is logged. The HTTP client reads service `auth` on every call, the PostgreSQL and MongoDB adapters open new connections with the new credential while open ones finish, and a rotated `server.tls` certificate or key reaches new connections.",
          "",
          "A failed refresh keeps the last value and logs `secrets.refresh.failed` at most once a minute per path; `onRefreshError: \"fail\"` also fails readiness. A value whose `expiresAt` passed without a refresh logs `secrets.expired`. With `health` on, the check `secrets` fails while any value is expired or failing (critical with `fail`, non-critical with `keep`), naming the paths.",
          "",
          "`secrets.get(\"<reference>\")` from `@quickservicets/core` reads any other reference at runtime through the same providers and cache (one resolution in flight), and `secrets.onRotate(\"<reference>\", (value) => ...)` rebuilds what depends on it, like a client.",
        ].join("\n"),
      },
    ],
  },
  options,
  api: (ctx): SecretsApi & { [RESOLVE_STARTUP_SECRETS]: () => Promise<void> } => {
    const options = ctx.options as unknown as SecretsOptions;
    const registry = providerRegistry();
    for (const provider of builtInProviders()) registry.add(provider, "secrets");
    const cache = new SecretCache({
      registry,
      resolve: resolveSettings(options),
      ttl: parseDuration(options.ttl) ?? 900_000,
      logger: ctx.logger,
      rotated: (entry) => rotated(ctx as never, entry),
      // A rotated certificate or key reaches new connections without a restart, once both changed in the same pass.
      afterPass: async (changed) => {
        if (changed.some((entry) => entry.locations.some((location) => location.path.startsWith("server.tls.")))) await reloadTlsValues();
      },
    });
    active = cache;
    setSecretsRuntime({ get: (reference) => cache.get(reference) });
    let timer: ReturnType<typeof setInterval> | undefined;
    // Each worker checks for due values in the background, never on the request path.
    ctx.app.onStart(() => {
      timer = setInterval(() => void cache.refreshDue(), parseDuration(options.refresh) ?? 60_000);
    });
    ctx.app.onStop(async () => {
      clearInterval(timer);
      if (active === cache) {
        active = undefined;
        setSecretsRuntime(undefined);
      }
      for (const provider of registry.all()) await provider.close?.();
    });
    return {
      provider: (provider: SecretProvider) => registry.add(provider, ctx.currentFeature() ?? "a feature"),
      status: () => ({ critical: options.onRefreshError === "fail", failing: cache.failingPaths() }),
      [RESOLVE_STARTUP_SECRETS]: () => resolveAtStartup(ctx as never, registry, cache),
    };
  },
});

export { secretsFeature };
export default secretsFeature;
