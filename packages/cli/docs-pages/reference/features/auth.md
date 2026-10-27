# auth

> One authentication contract for every provider: the first provider that accepts a request's credentials fills req.user, req.auth and optionally req.tenant.

One authentication contract for every provider: the first provider that accepts a request's credentials fills req.user, req.auth and optionally req.tenant.

## Enabling

Turn it on in `quickservicets.config.ts`:

```ts
auth: {}
```

It is not enabled by default: turn it on with `auth: {}` or `QS_AUTH_ENABLED=true`, and off with `auth: false` or `QS_AUTH_ENABLED=false`.

## Options

| Key | Type | Default | Environment variable | Per request | Description |
| --- | --- | --- | --- | --- | --- |
| `auth.enabled` | `boolean` | `true` | `QS_AUTH_ENABLED` | no | Turns the feature off when false. |

## Feature API

Other features reach it with `ctx.feature("auth")` in their setup, listing `auth` in `requires` or `after`.

### `provider`

```ts
provider(provider: AuthProvider): void;
```

Registers an authentication provider; providers are tried in registration order. Only available during setup.

## Error codes

| Status | Code | Message |
| --- | --- | --- |
| 401 | `UNAUTHORIZED` | Invalid credentials |
