---
title: Secrets
description: Keep secret values out of the configuration with references like secret("vault://kv/db#url"), resolved at startup by pluggable providers, cached, rotated without restarts, per tenant, checked before deploys and masked everywhere.
sidebar:
  order: 59
---

A service needs database passwords, API keys, signing secrets and private keys. Writing them in `quickservicets.config.ts` or in plain environment variables spreads them through repositories, CI logs and container images, and rotating one means a redeploy. The `secrets` native lets every secret value of the configuration be a reference to where the secret lives instead, like `secret("vault://kv/db#url")`: the service resolves it when it starts, keeps it fresh while it runs and masks it wherever it could be printed. The options, variables, hooks and contracts are listed on the [secrets reference page](/reference/features/secrets/).

The samples come from the example project `examples/minimal/secrets`: the database URL from `env://`, a payments API key from a file and a rotating partner token from a project provider backed by `local-vault.json`.

```ts title="quickservicets.config.ts"
import { join } from "node:path";
import { defineConfig, postgresAdapter, secret } from "@quickservicets/core";
import { localVault } from "./vault/local-vault.ts";

export default defineConfig({
  // The database URL is read from DATABASE_URL through the built-in env:// provider.
  database: postgresAdapter({ url: secret("env://DATABASE_URL") }),
  secrets: { providers: [localVault(join(import.meta.dir, "local-vault.json"))] },
  http: {
    services: {
      // The API key is the content of secrets/api-key, which bun run seed creates.
      payments: { url: "https://payments.example.com", auth: { apiKey: { header: "x-api-key", value: secret("file://secrets/api-key") } } },
      // The partner token rotates when local-vault.json changes.
      partner: { url: "https://partner.example.com", auth: { bearer: secret("local://partner#token") } },
    },
  },
});
```

## Why references

A reference names a secret without holding it: the configuration can be committed, reviewed and printed, the value stays in the vault (or the secrets file mounted by the platform), and access to it is the vault's job. The same configuration runs in every environment, each with its own vault or `beforeResolve` hook choosing its path, and a rotated secret reaches the running service without a restart.

## The reference syntax

A reference is `<scheme>://<path>[#<key>][?version=<version>]`:

- the scheme picks the provider: `env` and `file` are built in, and providers registered by features or the `providers` option add others (`vault`, `local`, …); URL schemes like `https`, `postgres` or `mongodb` can never be secret schemes;
- the path is what the provider looks up: `env://STRIPE_KEY` reads that variable, `file:///run/secrets/stripe` an absolute file and `file://secrets/api-key` a file relative to the project root (one trailing line break is removed);
- `#key` reads one property: of a key-value secret the provider returns as `values`, or of the value parsed as JSON;
- `?version=3` pins a version, for vaults that keep them.

`secret("nope")` throws `Invalid secret reference nope: …`, so a typo fails when the configuration loads.

## Where references work

References are accepted by every `secret()` option of the config and of every feature (like `http.services.*.auth` and `tls.passphrase`, `proxy.identity.secret` or `tenancy.connection`), by `server.tls.cert`, `key` and `passphrase`, by `files.signingSecret`, and by the `url` of `postgresAdapter` and `mongodbAdapter`. A declared variable of kind `secret()` whose text starts with a registered scheme and `://` is a reference too:

```bash
STRIPE_KEY=file:///run/secrets/stripe bun .generated/server.ts
```

A reference while the native is off fails with `<path> uses <reference>; add secrets: {} to quickservicets.config.ts`.

## Startup resolution and its errors

The native and the features that list `secrets` in `requires` or `enables` (the vault providers) set up first. Then every reference is resolved, each text once, with `timeout` (10 seconds) per attempt and `retries` (2) retries with backoff, before any other feature sets up and before the database connects; other features, adapters and `env` only ever see values. When references fail, startup stops with one error listing them all, never a value:

```text
Cannot resolve secrets:
  http.services.payments.auth.apiKey.value: file://secrets/api-key (not found)
  database.url: env://DATABASE_URL (the variable DATABASE_URL is not set)
```

## Caching, TTLs and leases

Each value is resolved again at its provider's `ttl`, or at two thirds of the time until its `expiresAt` (a lease), whichever comes first, and at the `ttl` option (15 minutes) when the provider gives neither. Every `refresh` (1 minute) each worker checks for due values and re-resolves them in the background, never on a request.

Code reads other references at runtime through the same providers and cache, with one resolution in flight per reference:

```ts
import { secrets } from "@quickservicets/core";

const key = await secrets.get("vault://kv/partner#key");
secrets.onRotate("vault://kv/partner#key", (value) => (client = createClient(value)));
```

## Rotation and what picks it up

A changed value replaces the old one in the config, the features' options and `env`, and behind `secretValue`, without a restart:

- the HTTP client reads service `auth` on every call, so the next call sends the new token;
- the PostgreSQL and MongoDB adapters open new connections with a rotated URL, while open connections finish their work;
- a rotated `server.tls` certificate and key reach new connections;
- `secrets.onRotate` callbacks rebuild what holds a derived object, like an SDK client.

The `onRotate` hooks get `{ path, reference, version }`, never the value, the `secret.rotated` event carries the same fields while `events` is on, and `secrets.rotated` is logged. A failed refresh keeps the last value and logs `secrets.refresh.failed` at most once a minute per path; a value whose lease expired without a refresh logs `secrets.expired` at error level.

## Per-tenant secrets

A reference with `{tenant}` in its path or key serves every tenant with its own secret, like `secret("vault://kv/tenants/{tenant}/db#url")`. It is not resolved at startup but for each tenant on first use, after the id is checked against the tenant id rule, so an id like `../admin` can never change the path. It works in `tenancy.connection`, in a tenant's `connection`, through `secrets.forTenant(id).get(reference)` and through `req.secrets.get(reference)` for the request's tenant; anywhere else startup fails with `<path> uses {tenant}, which only works for tenant connections, tenant entries and secrets.forTenant()`.

Each worker keeps at most `tenantCacheSize` (10000) per-tenant values, evicting the least recently used, and refreshes only the values read since they resolved, so idle tenants cost no vault calls. A failure fails only that tenant's request (503 for its database), logs `secrets.tenant.failed` and is not retried for 10 seconds. Creating the secrets of a new tenant in the vault is an operator task, done before the tenant is provisioned.

## Health

With `health` on, the readiness check `secrets` fails while a value is expired or failing to refresh, naming the paths and never the values. It is non-critical with `onRefreshError: "keep"` (readiness degrades) and critical with `"fail"` (readiness answers 503).

## `secrets check` in CI and deploys

`quickservicets secrets check` sets up only the features that register providers, resolves every reference and prints one line per reference, never a value, exiting 1 when one fails:

```bash
$ quickservicets secrets check
database.url env://DATABASE_URL ok
http.services.payments.auth.apiKey.value file://secrets/api-key ok
http.services.partner.auth.bearer local://partner#token ok
```

`--tenant acme` also resolves the `{tenant}` references for that tenant, and `--json` prints one document. Run it in CI against the deploy environment's vault and before starting a new version.

## Masking

Every resolved value, including the earlier value of a rotated secret and every per-tenant value, is added to the known secret values: it shows as `[secret]` in logs, error responses, error reports, printed configs and `env`.

## Writing a provider

A provider resolves the references of its schemes. `defineSecretProvider` checks the definition; `resolve` gets the reference (with `path`, `key` and `version`) and a `signal` to abort its request on timeout, and returns `{ value }` or `{ values }` with an optional `version`, `ttl` and `expiresAt`. A missing secret throws `SecretNotFoundError` and a refused access `SecretAccessError`; neither is retried, and neither message holds a value. The example's provider reads a JSON file:

```ts title="vault/local-vault.ts"
import { readFileSync } from "node:fs";
import { defineSecretProvider, SecretNotFoundError } from "@quickservicets/core";

/**
 * A project provider for `local://<path>[#<key>]` backed by a JSON file of secrets by path, read on every resolution
 * with a ttl of one minute, so editing the file rotates a secret without a restart.
 */
export function localVault(file: string) {
  return defineSecretProvider({
    name: "local-vault",
    schemes: ["local"],
    resolve(reference) {
      const secrets = JSON.parse(readFileSync(file, "utf8")) as Record<string, string | Record<string, string>>;
      const entry = secrets[reference.path];
      if (entry === undefined) throw new SecretNotFoundError(reference);
      return typeof entry === "string" ? { value: entry, ttl: "1m" } : { values: entry, ttl: "1m" };
    },
  });
}
```

A feature registers its provider with `ctx.feature("secrets").provider(p)` during its setup, after listing `secrets` in `requires` or `enables`; a project passes it in `providers`. HTTP-based providers call their API through a service registered with `addService`. `testSecretProvider(entries)` is a test double, and `runSecretProviderContract(create, { fixtures })` from `@quickservicets/core/testing` runs the contract every provider passes.

## Customization

The levels shared by every native, from the lightest to the deepest:

- Level 0: `secrets: {}` resolves `env://` and `file://` references with the defaults.
- Level 1: every option has a variable, like `QS_SECRETS_TTL=1m` or `QS_SECRETS_ON_REFRESH_ERROR=fail`.
- Level 2: not applicable; secrets are configuration values, so the native has no tags.
- Level 3: per request, a `{tenant}` reference resolves for each tenant.
- Level 4: `beforeResolve` may return another reference, like one with the environment's name; `onRotate` and `onResolveFailed` observe rotations and failures, never values.
- Level 5: not applicable; the native has no files to override.
- Level 6: a project provider in `providers`, like the example's `local://` vault.
- Level 7: `quickservicets eject secrets` copies the native into `features/secrets/`, where it replaces the built-in one.

```ts
secrets: {
  ttl: "5m",
  beforeResolve: ({ reference }) => (reference.startsWith("local://") ? reference.replace("local://", `local://${process.env.APP_ENV ?? "dev"}/`) : undefined),
},
```

## Vault providers

Each vault provider plugin adds its section here, with its scheme, its options and how it authenticates.
