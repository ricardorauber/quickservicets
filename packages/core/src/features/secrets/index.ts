import {
  clearStoredSecrets,
  createFeatureLifecycle,
  defineCommand,
  isSecretReference,
  list,
  provider,
  string,
  usesSecrets,
  hasTenantPlaceholder,
  referenceForTenant,
  TENANT_ID,
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
  secrets,
  secretsNow,
  secretsRuntime,
  secretVariables,
  setSecretsRuntime,
  storeSecretValue,
  type FeatureSetupContext,
  type ReferenceLocation,
  type SecretReference,
} from "../public.ts";
import type { SecretCheckLine, SecretProvider, SecretResolveFailure, SecretResolveStep, SecretsApi } from "./api.ts";
import { SecretCache, type CacheEntry, type SecretRotation } from "./cache.ts";
import { builtInProviders, providerRegistry, reasonOf, resolveReference, type ProviderRegistry, type ResolvedSecret } from "./resolve.ts";

export type { SecretCheckLine, SecretProvider, SecretResolution, SecretResolveContext, SecretResolveFailure, SecretResolveStep, SecretsApi } from "./api.ts";
export type { SecretRotation } from "./cache.ts";
export { dueTime } from "./cache.ts";
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
  tenantCacheSize: integer().min(1).default(10000).describe("The most per-tenant values each worker keeps; the least recently used is evicted."),
  providers: list(provider<SecretProvider>("SecretProvider", ["resolve"]))
    .default([])
    .describe("Project providers registered next to the built-in env and file ones and those of features, each for its schemes."),
  beforeResolve: hook<SecretResolveStep, undefined>().describe(
    "Runs before each resolution with the reference, its config path and the tenant; it may return another reference (a text or secret()), like one with an environment prefix.",
  ),
  onResolveFailed: hook<SecretResolveFailure, undefined>().describe("Runs when a resolution or refresh fails, with the reference, its path, the tenant and the reason, never a value."),
});

type SecretsOptions = {
  timeout: string;
  retries: number;
  ttl: string;
  refresh: string;
  onRefreshError: "keep" | "fail";
  onRotate: ((rotation: SecretRotation) => unknown)[];
  tenantCacheSize: number;
  providers: SecretProvider[];
  beforeResolve: ((step: SecretResolveStep, ctx: undefined) => unknown)[];
  onResolveFailed: ((failure: SecretResolveFailure, ctx: undefined) => unknown)[];
};

/** The reference a provider receives: the one `beforeResolve` hooks return, in order, or the reference itself. */
async function prepared(options: SecretsOptions, reference: SecretReference, path: string, tenant?: string): Promise<SecretReference> {
  let current = reference;
  for (const hook of options.beforeResolve) {
    const result = await hook({ reference: current.text, path, ...(tenant !== undefined ? { tenant } : {}) }, undefined);
    if (isSecretReference(result)) current = result;
    else if (typeof result === "string") current = parseSecretReference(result);
  }
  return current;
}

/** Tells the `onResolveFailed` hooks about a failure, logging a hook that throws instead of failing. */
async function failed(ctx: FeatureSetupContext<SecretsOptions>, failure: SecretResolveFailure): Promise<void> {
  if (ctx.options.onResolveFailed.length === 0) return;
  try {
    await runAfterHooks(ctx.options.onResolveFailed as never, failure, undefined);
  } catch (error) {
    safeLog(ctx.logger, "error", { timestamp: new Date(secretsNow()).toISOString(), message: "secrets.hook.failed", path: failure.path, error: { message: (error as Error)?.message ?? String(error) } });
  }
}

/** The places a `{tenant}` reference may be: the tenancy connection and the connections of configured tenants. */
const TENANT_LOCATION = /^tenancy\.(connection|tenants\.[^.]+\.connection)$/;

/** How long a failed per-tenant resolution is refused before the provider is called again. */
export const TENANT_RETRY_MS = 10_000;

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
 * Resolves every reference once (the same text once), puts each value in place of its references and keeps it in the
 * cache; fails with one `ConfigError` listing every failure, never a value.
 */
async function resolveAtStartup(ctx: FeatureSetupContext<SecretsOptions>, registry: ProviderRegistry, cache: SecretCache): Promise<void> {
  const problems: string[] = [];
  // A service starting again in this process resolves its references anew.
  clearStoredSecrets();
  const found = startupReferences(ctx, registry, problems);
  // References with {tenant} resolve per tenant on first use; they only work where a tenant is known.
  const placeholders = found.filter((location) => hasTenantPlaceholder(location.reference));
  const misplaced = placeholders.filter((location) => !TENANT_LOCATION.test(location.path));
  if (misplaced.length > 0) throw new ConfigError(misplaced.map((location) => `${location.path} uses {tenant}, which only works for tenant connections, tenant entries and secrets.forTenant()`).join("\n"));
  const locations = found.filter((location) => !hasTenantPlaceholder(location.reference));
  const pending = new Map<string, Promise<ResolvedSecret>>();
  for (const location of locations) {
    const { reference } = location;
    if (!pending.has(reference.text)) pending.set(reference.text, prepared(ctx.options, reference, location.path).then((actual) => resolveReference(registry, actual, resolveSettings(ctx.options))));
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
    if (result.ok) continue;
    problems.push(`${location.path}: ${location.reference.text} (${result.reason})`);
    await failed(ctx, { reference: location.reference.text, path: location.path, reason: result.reason });
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

/** Checks the references of the service set up last in this process, for `quickservicets secrets check`. */
let latestCheck: ((tenant?: string) => Promise<SecretCheckLine[]>) | undefined;

/**
 * Resolves every reference of the configuration once (with `tenant`, also the `{tenant}` references for that tenant),
 * without failing: one line per reference with its path, its text and `ok` with the version or the reason.
 */
async function checkReferences(ctx: FeatureSetupContext<SecretsOptions>, registry: ProviderRegistry, tenant?: string): Promise<SecretCheckLine[]> {
  const problems: string[] = [];
  const found = startupReferences(ctx, registry, problems);
  const lines: SecretCheckLine[] = problems.map((problem) => {
    const [path, ...rest] = problem.split(": ");
    return { path: path!, reference: "", ok: false, reason: rest.join(": ") };
  });
  if (tenant !== undefined && !TENANT_ID.test(tenant)) throw new ConfigError(`Invalid tenant id ${JSON.stringify(tenant)}`);
  const results = new Map<string, Promise<ResolvedSecret>>();
  for (const location of found) {
    const placeholder = hasTenantPlaceholder(location.reference);
    if (placeholder && tenant === undefined) continue;
    const reference = placeholder ? referenceForTenant(location.reference, tenant!) : location.reference;
    let work = results.get(reference.text);
    if (!work) {
      work = prepared(ctx.options, location.reference, location.path, placeholder ? tenant : undefined).then((actual) =>
        resolveReference(registry, placeholder ? referenceForTenant(actual, tenant!) : actual, resolveSettings(ctx.options)),
      );
      work.catch(() => {});
      results.set(reference.text, work);
    }
    try {
      const resolved = await work;
      lines.push({ path: location.path, reference: location.reference.text, ok: true, ...(resolved.version !== undefined ? { version: resolved.version } : {}) });
    } catch (error) {
      lines.push({ path: location.path, reference: location.reference.text, ok: false, reason: reasonOf(reference, error) });
    }
  }
  return lines;
}

const checkCommand = defineCommand({
  name: "secrets check",
  usage: "quickservicets secrets check [--tenant <id>]",
  description:
    "Resolves every secret reference of the configuration (with --tenant, also its per-tenant references for that tenant) and prints one line per reference with its config path, the reference, ok and the version or failed and the reason, never a value; exits 1 when one fails.",
  flags: object({ tenant: string().optional().describe("Also resolves the per-tenant references for this tenant id.") }),
  json: { references: [{ path: "string", reference: "string", ok: "boolean", version: "string?", reason: "string?" }] },
  async run(ctx) {
    // Only the features that register providers set up, without resolving the references at startup.
    const features = ctx.config.features.filter((feature) => usesSecrets(feature.definition));
    const lifecycle = createFeatureLifecycle({ features, config: ctx.config, models: [], worker: { index: 0, count: 1, runsScheduledWork: false }, resolveSecrets: false });
    latestCheck = undefined;
    await lifecycle.setup();
    const lines = await latestCheck!(ctx.flags.tenant);
    for (const line of lines) ctx.output.log(`${line.path} ${line.reference} ${line.ok ? `ok${line.version !== undefined ? ` version ${line.version}` : ""}` : `failed: ${line.reason}`}`);
    if (lines.length === 0) ctx.output.log("No secret references.");
    ctx.result({ references: lines.map((line) => ({ path: line.path, reference: line.reference, ok: line.ok, ...(line.version !== undefined ? { version: line.version } : {}), ...(line.reason !== undefined ? { reason: line.reason } : {}) })) });
    return lines.some((line) => !line.ok) ? 1 : 0;
  },
});

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
          "`env://NAME` reads the variable (unset or empty fails), and `file://<path>` the file's content without one trailing line break (`file:///abs/path` for an absolute path, otherwise relative to the project root). `#<key>` reads that property of the value parsed as JSON.",
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
        title: "Customization",
        text: [
          "No tags: secrets are configuration values, not entity, field or route options, so the native has no JSDoc tags.",
          "",
          "No files: the native has no endpoints, hooks or entity files to override.",
          "",
          "The per-request level is the per-tenant reference: `{tenant}` in a reference resolves for the request's tenant. The hooks `beforeResolve` (it may return another reference, like `vault://kv/staging/db` for `vault://kv/db`), `onRotate` and `onResolveFailed` never receive values. The `providers` option registers project providers, `ctx.feature(\"secrets\").provider(p)` registers a feature's, and `quickservicets eject secrets` copies the native into `features/secrets/`.",
          "",
          "`quickservicets secrets check [--tenant <id>]` sets up only the features that register providers, resolves every reference (with `--tenant`, also the `{tenant}` ones for that tenant) and prints `<path> <reference> ok version <n>` or `<path> <reference> failed: <reason>` per reference, never a value, exiting 1 when one fails; run it in CI and before deploys.",
        ].join("\n"),
      },
      {
        title: "Providers",
        text: [
          "A provider is `defineSecretProvider({ name, schemes, resolve, health?, close?, transport? })` from `@quickservicets/core`; `resolve(reference, { signal })` resolves `{ value }` or `{ values }` (a key-value secret, from which the core takes `#key`; without a key a single entry is taken, and several fail with `<reference>: the secret has several keys; add #<key>`), with optional `version`, `ttl` and `expiresAt`. It aborts its requests when `signal` aborts, honors `?version=`, reports a missing secret or version with `SecretNotFoundError` and a refused access with `SecretAccessError` (neither is retried), and calls its API through a service registered with `addService` unless `transport: \"sdk\"` says an official SDK makes the calls.",
          "",
          "`testSecretProvider(entries)` and `runSecretProviderContract(create, { fixtures })` of `@quickservicets/core/testing` give provider authors a test double and the contract every provider passes; the repository runs it for every `packages/plugin-secrets-*` package.",
        ].join("\n"),
      },
      {
        title: "Per-tenant secrets",
        text: [
          "A reference may hold `{tenant}` in its path or key, like `secret(\"vault://kv/tenants/{tenant}/db#url\")`: it is not resolved at startup but for each tenant on first use, with the id checked against the tenant id rule first, so it cannot change the path. It works in `tenancy.connection` and in a tenant's `connection` (resolved when the tenant's pool opens), through `secrets.forTenant(id).get(reference)`, and through `req.secrets.get(reference)` for the request's tenant; anywhere else (a global option, `env`, an adapter) startup fails with `<path> uses {tenant}, which only works for tenant connections, tenant entries and secrets.forTenant()`.",
          "",
          "Each worker keeps at most `tenantCacheSize` per-tenant values, evicting the least recently used, with one resolution in flight per tenant and reference; only values read since they resolved are refreshed, so idle tenants cost no vault calls. A failed resolution fails only that tenant's request (503 for its database), logs `secrets.tenant.failed` with the tenant and the reference, and is not retried for 10 seconds. Creating the secrets of a new tenant in the vault is an operator task.",
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
  commands: [checkCommand],
  request: {
    // The request's secrets: `{tenant}` references resolve for the request's tenant.
    secrets: (req) => ({
      get: (reference: SecretReference | string) => {
        const parsed = typeof reference === "string" ? parseSecretReference(reference) : reference;
        if (!hasTenantPlaceholder(parsed)) return secrets.get(parsed);
        if (!req.tenant) return Promise.reject(new Error(`req.secrets.get(${parsed.text}) needs the request's tenant`));
        return secrets.forTenant(req.tenant.id).get(parsed);
      },
    }),
  },
  api: (ctx): SecretsApi & { [RESOLVE_STARTUP_SECRETS]: () => Promise<void> } => {
    const options = ctx.options as unknown as SecretsOptions;
    const registry = providerRegistry();
    for (const provider of builtInProviders()) registry.add(provider, "secrets");
    for (const provider of options.providers) registry.add(provider, "secrets.providers");
    const cache = new SecretCache({
      registry,
      resolve: resolveSettings(options),
      ttl: parseDuration(options.ttl) ?? 900_000,
      logger: ctx.logger,
      prepare: (reference, paths) => prepared(options, reference, paths[0] ?? reference.text),
      failure: (reference, paths, reason) => Promise.all(paths.map((path) => failed(ctx as never, { reference: reference.text, path, reason }))).then(() => {}),
      rotated: (entry) => rotated(ctx as never, entry),
      // A rotated certificate or key reaches new connections without a restart, once both changed in the same pass.
      afterPass: async (changed) => {
        if (changed.some((entry) => entry.locations.some((location) => location.path.startsWith("server.tls.")))) await reloadTlsValues();
      },
    });
    // Per-tenant values: resolved on first use, the least recently used evicted, and only those in use refreshed.
    const tenantCache = new SecretCache({
      registry,
      resolve: resolveSettings(options),
      ttl: parseDuration(options.ttl) ?? 900_000,
      logger: ctx.logger,
      maxEntries: options.tenantCacheSize,
      onlyUsed: true,
      failureCooldown: TENANT_RETRY_MS,
      prepare: (reference) => {
        const owner = tenantOf.get(reference.text);
        return owner ? prepared(options, owner.reference, owner.reference.text, owner.tenant).then((actual) => referenceForTenant(actual, owner.tenant)) : reference;
      },
      failure: (reference, _paths, reason) => {
        const owner = tenantOf.get(reference.text);
        return owner ? failed(ctx as never, { reference: owner.reference.text, path: owner.reference.text, tenant: owner.tenant, reason }) : undefined;
      },
      rotated: () => {},
    });
    /** The tenant and the `{tenant}` reference of each per-tenant entry, for the hooks. */
    const tenantOf = new Map<string, { tenant: string; reference: SecretReference }>();
    const forTenant = async (tenant: string, reference: SecretReference): Promise<string> => {
      // The id becomes part of the vault path, so only ids of the tenant id rule are accepted.
      if (typeof tenant !== "string" || !TENANT_ID.test(tenant)) throw new Error(`Invalid tenant id ${JSON.stringify(tenant)} for ${reference.text}`);
      if (!hasTenantPlaceholder(reference)) return cache.get(reference);
      const own = referenceForTenant(reference, tenant);
      if (!tenantOf.has(own.text) && tenantOf.size >= options.tenantCacheSize * 2) tenantOf.clear();
      tenantOf.set(own.text, { tenant, reference });
      try {
        return await tenantCache.get(own);
      } catch (error) {
        safeLog(ctx.logger, "error", { timestamp: new Date(secretsNow()).toISOString(), message: "secrets.tenant.failed", tenant, reference: reference.text, reason: reasonOf(reference, error) });
        throw error;
      }
    };
    const refresh = async () => void (await Promise.all([cache.refreshDue(), tenantCache.refreshDue()]));
    const runtime = { get: (reference: SecretReference) => cache.get(reference), forTenant, resolves: (scheme: string) => registry.has(scheme), refresh };
    setSecretsRuntime(runtime);
    let timer: ReturnType<typeof setInterval> | undefined;
    // Each worker checks for due values in the background, never on the request path.
    ctx.app.onStart(() => {
      timer = setInterval(() => void refresh(), parseDuration(options.refresh) ?? 60_000);
    });
    ctx.app.onStop(async () => {
      clearInterval(timer);
      if (secretsRuntime() === runtime) setSecretsRuntime(undefined);
      for (const provider of registry.all()) await provider.close?.();
    });
    latestCheck = (tenant) => checkReferences(ctx as never, registry, tenant);
    return {
      provider: (provider: SecretProvider) => registry.add(provider, ctx.currentFeature() ?? "a feature"),
      status: () => ({ critical: options.onRefreshError === "fail", failing: cache.failingPaths() }),
      [RESOLVE_STARTUP_SECRETS]: () => resolveAtStartup(ctx as never, registry, cache),
    };
  },
});

export { secretsFeature };
export default secretsFeature;
