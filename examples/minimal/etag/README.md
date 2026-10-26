# etag

The smallest project that shows the `etag` native: a `Document` entity whose reads and writes carry an entity tag, whose conditional reads answer 304, and whose edits need `If-Match`, so two people editing one version never overwrite each other.

```bash
bun run test
```

The optimistic concurrency guide (`docs/src/content/docs/guides/optimistic-concurrency.md`, on the site at `/guides/optimistic-concurrency/`) explains every piece.

## Level 0: enable

Turn the native on; every record read or written through the generated routes gets an `ETag`, and writes honor `If-Match`:

```ts
export default defineConfig({ database: memoryAdapter(), etag: {} });
```

## Level 1: options and environment

`required` makes every generated write need `If-Match`, and every option has a `QS_*` variable:

```ts
etag: { required: true }
```

```bash
QS_ETAG_REQUIRED=true bun .generated/server.ts
```

## Level 2: tags

`@etag required=true` requires `If-Match` on one entity's writes, `@etag required=false` exempts one, and `@etag off` removes tags and conditions from its routes:

```ts
/** @etag required=true */
export type Document = { title: string; body: string; version: number };
```

## Level 3: per request

`required` can be a function of the request, its user and tenant:

```ts
etag: { required: ({ req }) => req?.headers.get("x-client") === "web" }
```

## Level 4: hooks and events

`onPreconditionFailed` may replace the 412, for example with the current record, and `onNotModified` observes each 304:

```ts
etag: {
  onPreconditionFailed: async ({ current }) => Response.json({ error: "stale", current }, { status: 412 }),
  onNotModified: ({ entity, id }) => console.debug("not modified", entity, id),
}
```

## Level 5: override files

The native contributes no files; a custom endpoint replacing a generated route tags its response with `res.etag` and writes conditionally with `{ ifMatch }`:

```ts
// endpoints/documents/[id]/patch.ts
export default async (repos: Repositories, req: ServiceRequest, res: ServiceResponse) => {
  const document = await repos.documents.update(req.params.id!, await req.json(), { ifMatch: req.headers.get("if-match") ?? "*" });
  res.etag(document);
  return document;
};
```

## Level 6: replace the implementation

`tagger` replaces `etagOf`, like the version tagger of `tagger.ts`; conditional writes still check atomically:

```ts
etag: { tagger: versionTagger }
```

## Level 7: eject

Copy the native into the project as a `features/etag/` project feature that replaces it:

```bash
quickservicets eject etag
```
