---
title: Optimistic concurrency
description: Give every record an entity tag, answer conditional reads with 304, and stop lost updates with If-Match, so two people editing one record never overwrite each other.
sidebar:
  order: 52
---

Two people open the same document. Ana saves her change; a minute later Bob saves his, written over the version he read, and Ana's change is gone without anyone noticing: a lost update. The `etag` native prevents it without locks: every record read or written carries an entity tag, and a client sending its tag back with `If-Match` writes only if nobody changed the record since. The same tags let clients skip downloading a record they already have. The options, variables, tag and hooks are listed on the [etag reference page](/reference/features/etag/).

The samples come from the example project `examples/minimal/etag`: a `Document` entity whose edits require `If-Match`, and a version tagger.

## Entity tags

With `etag: {}`, the generated read, create, update and replace routes answer with an `ETag` header: a strong tag computed by `etagOf(record)` from the record's id and `updatedAt`, which changes on every write and reveals neither. Field selection (`?fields=title`) does not change it, and reads also get `Cache-Control: private, no-cache` unless a hook or the handler set one.

```ts title="quickservice.config.ts"
import { defineConfig, memoryAdapter } from "@quickservice/core";

export default defineConfig({
  database: memoryAdapter(),
  etag: {},
});
```

## Conditional reads

A client that kept a record and its tag asks with `If-None-Match: <tag>`; when the record did not change, the answer is `304 Not Modified` with no body. The read's pre-hooks run first, so a client without permission gets its `403` as before. `If-None-Match: *` matches any existing record, and weak tags (`W/"…"`) compare as their strong form.

## Conditional writes

`PATCH`, `PUT` and `DELETE` of the generated routes with `If-Match: <tag>` write only when the record still has that tag; otherwise the answer is `412 PRECONDITION_FAILED` `Record was changed by another request`, with the current tag in `ETag`, and nothing changes. The check is atomic: the repository compares the tag and writes with a condition on the `updatedAt` it checked, so of two writes with the same tag exactly one succeeds. Weak tags never match `If-Match`, and a matching `DELETE` applies the `@onDelete` rules in the same transaction.

## `If-Match: *`

`If-Match: *` writes only when the record exists, answering `404` otherwise, without comparing versions: useful for an update that must never create or resurrect a record.

## Required tags

`required: true` (or `QS_ETAG_REQUIRED=true`) makes every generated write without `If-Match` answer `428 PRECONDITION_REQUIRED` `If-Match header is required`; `@etag required=true` does it for one entity and `@etag required=false` exempts one. `@etag off` removes tags and conditions from an entity's routes.

```ts title="entities/Document.ts"
/** @etag required=true */
export type Document = {
  title: string;
  body: string;
  /** @default 1 */
  version: number;
};
```

`required` can also be a function of the request, like `({ req }) => req?.headers.get("x-client") === "web"`, to require tags from one kind of client only.

## Repository use

Code writes conditionally with the `ifMatch` option of `update`, `replace` and `delete`, which works without the native too and throws the same `412 HttpError`:

```ts
await repos.documents.update(id, { body }, { ifMatch: tagTheClientSent });
```

A custom endpoint that replaces a generated route tags its own response with `res.etag(record)` (or a text), which also answers 304 to a matching `If-None-Match`.

## Client flows

1. Read the record and keep its `ETag` with it.
2. Edit, then send the change with `If-Match: <that tag>`.
3. On `200`, keep the new `ETag` of the response for the next edit.
4. On `412`, someone changed it first: read the record again (the response's `ETag` is its current tag), show the difference or merge, and retry with the new tag; never retry blindly with the old one.
5. On `428`, the route requires tags: read first.

## Hooks

`onPreconditionFailed` receives `{ req, entity, id, expected, current }` and may return a `Response` that replaces the 412, for example one with the current record so the client can merge without another request; `onNotModified` receives `{ req, entity, id }` for each 304.

```ts
etag: { onPreconditionFailed: async ({ current }) => Response.json({ error: "stale", current }, { status: 412 }) }
```

## The tagger

`tagger` replaces `etagOf` for the native's routes: its `tag(record, entity)` returns a strong tag, quoted when it is not. Conditional writes compare the tagger's value read inside the transaction and keep the `updatedAt` condition, so they stay atomic:

```ts title="tagger.ts"
import type { EntityTagger } from "@quickservice/core";

/** Tags a document with its version, like `"v3"`, in place of the default hash of its id and `updatedAt`. */
export const versionTagger: EntityTagger = {
  tag: (record) => `"v${String(record.version ?? 0)}"`,
};
```

## See also

- [Etag reference](/reference/features/etag/): every option with its variable, the tag and the hooks.
- [Idempotency keys](/guides/idempotency/): safe retries of `POST`, the other half of retrying writes.
