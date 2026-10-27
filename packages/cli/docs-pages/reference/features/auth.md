# auth

> One authentication contract for every provider: the first provider that accepts a request's credentials fills req.user, req.auth and optionally req.tenant.

One authentication contract for every provider: the first provider that accepts a request's credentials fills req.user, req.auth and optionally req.tenant.

## Enabling

Turn it on in `quickservicets.config.ts`:

```ts
auth: {}
```

It is not enabled by default: turn it on with `auth: {}` or `QS_AUTH_ENABLED=true`, and off with `auth: false` or `QS_AUTH_ENABLED=false`.

**Runs after:** `health`, `history`, `realtime`

## Options

| Key | Type | Default | Environment variable | Per request | Description |
| --- | --- | --- | --- | --- | --- |
| `auth.required` | `boolean` | `false` | `QS_AUTH_REQUIRED` | no | Every route needs a signed-in user unless tagged @auth off; runtime routes registered with auth: false stay public. |
| `auth.scopes` | `string[]` | `[]` | `QS_AUTH_SCOPES` | no | The token scopes every route that needs a user requires, unless its @auth tag lists its own. |
| `auth.roles` | `string[]` | `[]` | `QS_AUTH_ROLES` | no | The roles every route requires, as role or role:operation entries like the @roles tag (admin, admin:delete); empty by default. |
| `auth.enabled` | `boolean` | `true` | `QS_AUTH_ENABLED` | no | Turns the feature off when false. |

## Tags

### `@auth`

`@auth` requires a signed-in user on every route of an entity or on one endpoint, `@auth scopes=posts:write` also requires token scopes, and `@auth off` keeps the target public when `required` is true.

**Applies to:** entities, endpoints

**Syntax:** `@auth [scopes=…]` or `@auth off`

**Options:** `auth.scopes`

```ts
/** @auth */
export type Post = { title: string };
```

### `@roles`

`@roles admin` requires one of the roles on every route of the target; on entities, `@roles admin:delete` restricts one operation (list, read, create, update, replace, delete) or a group (view, write).

**Applies to:** entities, endpoints

**Syntax:** `@roles <roles>` or `@roles off`

**Options:** `auth.roles`

```ts
/** @roles editor:write,admin:delete */
export type Post = { title: string };
```

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
| 401 | `UNAUTHORIZED` | Authentication required |
| 403 | `FORBIDDEN` | Not allowed |
| 403 | `FORBIDDEN` | Insufficient scope |
