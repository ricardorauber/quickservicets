# secrets

> Secret references like secret("vault://kv/db#url") in the configuration, resolved at startup by pluggable providers, with built-in env:// and file:// providers.

Secret references like secret("vault://kv/db#url") in the configuration, resolved at startup by pluggable providers, with built-in env:// and file:// providers.

## Enabling

Turn it on in `quickservicets.config.ts`:

```ts
secrets: {}
```

It is not enabled by default: turn it on with `secrets: {}` or `QS_SECRETS_ENABLED=true`, and off with `secrets: false` or `QS_SECRETS_ENABLED=false`.

## Options

| Key | Type | Default | Environment variable | Per request | Description |
| --- | --- | --- | --- | --- | --- |
| `secrets.timeout` | `duration` | `"10s"` | `QS_SECRETS_TIMEOUT` | no | The longest each attempt to resolve a reference may take. |
| `secrets.retries` | `integer` | `2` | `QS_SECRETS_RETRIES` | no | How many times a failed resolution is retried, with backoff, before startup fails. |
| `secrets.ttl` | `duration` | `"15m"` | `QS_SECRETS_TTL` | no | How long a value is kept before it is resolved again, when its provider gives no ttl or expiry. |
| `secrets.refresh` | `duration` | `"1m"` | `QS_SECRETS_REFRESH` | no | How often each worker checks for values that are due, re-resolving them in the background. |
| `secrets.onRefreshError` | `"keep" \| "fail"` | `"keep"` | `QS_SECRETS_ON_REFRESH_ERROR` | no | What a failed refresh does: keep serves the last value, fail also fails the readiness check; both retry at the next check. |
| `secrets.onRotate` | `hook` | — | not overridable | no | Runs after a value changed, with the config path, the reference and the new version, never the value. |
| `secrets.enabled` | `boolean` | `true` | `QS_SECRETS_ENABLED` | no | Turns the feature off when false. |
| `secrets.database` | `string` | — | `QS_SECRETS_DATABASE` | no | The database of the feature's own tables, `default` or a name of `databases`; tables of one entity follow it, and per-database tables exist in every database (default: the default database). |

## Hooks

Hooks are functions (or lists of functions) written in the config; `before` hooks may change the value or cancel the step by throwing, `after` and `on` hooks observe.

| Hook | Kind | Description |
| --- | --- | --- |
| `secrets.onRotate` | on | Runs after a value changed, with the config path, the reference and the new version, never the value. |

## Feature API

Other features reach it with `ctx.feature("secrets")` in their setup, listing `secrets` in `requires` or `after`.

### `provider`

```ts
provider(provider: SecretProvider): void;
```

Registers a provider for its schemes during the calling feature's setup; a scheme registered twice, or one of the
reserved URL schemes, fails startup naming it.

### `status`

```ts
status(): { critical: boolean; failing: string[] };
```

Whether a failing refresh fails readiness (`onRefreshError: "fail"`), and the paths of the values failing to refresh or expired.

## References

A reference is `<scheme>://<path>[#<key>][?version=<version>]`, written as `secret("env://STRIPE_KEY")` in `quickservicets.config.ts`. It is accepted by every `secret()` option of the config and of the features, by `server.tls.cert`, `key` and `passphrase`, by `files.signingSecret`, and by the `url` of `postgresAdapter` and `mongodbAdapter`. A declared variable of kind `secret()` whose text starts with a registered scheme and `://`, like `STRIPE_KEY=file:///run/secrets/stripe`, is a reference too.

`env://NAME` reads the variable (unset or empty fails), and `file://<path>` the file's content without one trailing line break (`file:///abs/path` for an absolute path, otherwise relative to the working directory). `#<key>` reads that property of the value parsed as JSON.

## Startup

The native and the features that list `secrets` in `requires` or `enables` set up first; then every reference is resolved, each text once, with `timeout` per attempt and `retries` retries. Other features, adapters and `env` only see values. Failures stop startup with one error starting `Cannot resolve secrets:` and one line per failure, `<config path>: <reference> (<reason>)`, never a value.

Resolved values are masked as `[secret]` in logs, errors, reports and printed configs. A reference while the native is off fails with `<path> uses <reference>; add secrets: {} to quickservicets.config.ts`.

## Cache and rotation

Each value is due again at its provider's `ttl`, or at two thirds of the time until its `expiresAt`, whichever comes first (the `ttl` option when the provider gives neither). Every `refresh`, each worker re-resolves the due values in the background, never on the request path.

A changed value replaces the old one in the config, the features' options and `env`, and behind `secretValue`; both stay masked. The `onRotate` hooks get `{ path, reference, version }` (never the value), `secret.rotated` is emitted with the same fields while `events` is on, and `secrets.rotated` is logged. The HTTP client reads service `auth` on every call, the PostgreSQL and MongoDB adapters open new connections with the new credential while open ones finish, and a rotated `server.tls` certificate or key reaches new connections.

A failed refresh keeps the last value and logs `secrets.refresh.failed` at most once a minute per path; `onRefreshError: "fail"` also fails readiness. A value whose `expiresAt` passed without a refresh logs `secrets.expired`. With `health` on, the check `secrets` fails while any value is expired or failing (critical with `fail`, non-critical with `keep`), naming the paths.

`secrets.get("<reference>")` from `@quickservicets/core` reads any other reference at runtime through the same providers and cache (one resolution in flight), and `secrets.onRotate("<reference>", (value) => ...)` rebuilds what depends on it, like a client.
