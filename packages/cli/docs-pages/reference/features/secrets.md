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
| `secrets.enabled` | `boolean` | `true` | `QS_SECRETS_ENABLED` | no | Turns the feature off when false. |
| `secrets.database` | `string` | — | `QS_SECRETS_DATABASE` | no | The database of the feature's own tables, `default` or a name of `databases`; tables of one entity follow it, and per-database tables exist in every database (default: the default database). |

## Feature API

Other features reach it with `ctx.feature("secrets")` in their setup, listing `secrets` in `requires` or `after`.

### `provider`

```ts
provider(provider: SecretProvider): void;
```

Registers a provider for its schemes during the calling feature's setup; a scheme registered twice, or one of the
reserved URL schemes, fails startup naming it.

## References

A reference is `<scheme>://<path>[#<key>][?version=<version>]`, written as `secret("env://STRIPE_KEY")` in `quickservicets.config.ts`. It is accepted by every `secret()` option of the config and of the features, by `server.tls.cert`, `key` and `passphrase`, by `files.signingSecret`, and by the `url` of `postgresAdapter` and `mongodbAdapter`. A declared variable of kind `secret()` whose text starts with a registered scheme and `://`, like `STRIPE_KEY=file:///run/secrets/stripe`, is a reference too.

`env://NAME` reads the variable (unset or empty fails), and `file://<path>` the file's content without one trailing line break (`file:///abs/path` for an absolute path, otherwise relative to the working directory). `#<key>` reads that property of the value parsed as JSON.

## Startup

The native and the features that list `secrets` in `requires` or `enables` set up first; then every reference is resolved, each text once, with `timeout` per attempt and `retries` retries. Other features, adapters and `env` only see values. Failures stop startup with one error starting `Cannot resolve secrets:` and one line per failure, `<config path>: <reference> (<reason>)`, never a value.

Resolved values are masked as `[secret]` in logs, errors, reports and printed configs. A reference while the native is off fails with `<path> uses <reference>; add secrets: {} to quickservicets.config.ts`.
