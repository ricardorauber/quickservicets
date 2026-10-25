# etag

The smallest project that shows the `etag` native: a `Document` entity whose reads and writes carry an entity tag, and whose conditional reads answer 304.

```bash
bun run test
```

## Level 0: enable

Turn the native on; every record read or written through the generated routes gets an `ETag`:

```ts
export default defineConfig({ database: memoryAdapter(), etag: {} });
```

## Level 1: options and environment

The native is switched by its variable:

```bash
QS_ETAG_ENABLED=false bun .generated/server.ts
```

## Level 2: tags

Not applicable: the native declares no tag yet.

## Level 3: per request

Not applicable: no option is resolved per request yet.

## Level 4: hooks and events

Not applicable: the native declares no hook yet.

## Level 5: override files

A custom endpoint tags its own response with `res.etag`, which also answers 304 to a matching `If-None-Match`:

```ts
export default async (repos: Repositories, req: ServiceRequest, res: ServiceResponse) => {
  const document = await repos.documents.findById(req.params.id!);
  res.etag(document!);
  return { title: document!.title };
};
```

## Level 6: replace the implementation

Not applicable: tags are computed by `etagOf` only so far.

## Level 7: eject

Copy the native into the project as a `features/etag/` project feature that replaces it:

```bash
quickservice eject etag
```
