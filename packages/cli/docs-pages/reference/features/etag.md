# etag

> Entity tags on record reads and writes, with 304 answers to conditional reads and 412 answers to stale conditional writes.

Entity tags on record reads and writes, with 304 answers to conditional reads and 412 answers to stale conditional writes.

## Enabling

Turn it on in `quickservicets.config.ts`:

```ts
etag: {}
```

It is not enabled by default: turn it on with `etag: {}` or `QS_ETAG_ENABLED=true`, and off with `etag: false` or `QS_ETAG_ENABLED=false`.

## Options

| Key | Type | Default | Environment variable | Per request | Description |
| --- | --- | --- | --- | --- | --- |
| `etag.required` | `boolean` | `false` | `QS_ETAG_REQUIRED` | yes | Rejects PATCH, PUT and DELETE requests of the generated routes without If-Match with 428; a function of the request decides per request. |
| `etag.onPreconditionFailed` | `hook` | — | not overridable | no | Runs when a conditional write is refused, with the request, entity, id, expected and current tags; a Response it returns replaces the 412. |
| `etag.onNotModified` | `hook` | — | not overridable | no | Runs for each 304 answer, with the request, the entity and the id. |
| `etag.tagger` | `EntityTagger` | — | not overridable | no | Replaces etagOf for the native's routes: its tag method gets the stored record and the entity and returns a strong tag. |
| `etag.enabled` | `boolean` | `true` | `QS_ETAG_ENABLED` | no | Turns the feature off when false. |

## Tags

### `@etag`

`@etag required=true` requires If-Match on the entity's PATCH, PUT and DELETE routes, `@etag required=false` exempts it, and `@etag off` removes tags and conditions from its routes.

**Applies to:** entities

**Syntax:** `@etag [required=…]` or `@etag off`

**Options:** `etag.required`

```ts
/** @etag required=true */
export type Invoice = { total: number };
```

## Hooks

Hooks are functions (or lists of functions) written in the config; `before` hooks may change the value or cancel the step by throwing, `after` and `on` hooks observe.

| Hook | Kind | Description |
| --- | --- | --- |
| `etag.onPreconditionFailed` | on | Runs when a conditional write is refused, with the request, entity, id, expected and current tags; a Response it returns replaces the 412. |
| `etag.onNotModified` | on | Runs for each 304 answer, with the request, the entity and the id. |
