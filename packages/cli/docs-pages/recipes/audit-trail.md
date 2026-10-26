# An audit trail

> Keep every version of one entity's records for a year, with who changed them, readable only by the record's owner and by auditors.

**The problem:** a document changes and someone asks who changed it, when, and what it said before. The answer must be readable by the people allowed to read the document, and not kept forever.

**The solution:** [entity history](/guides/history/) on the documents, the history routes guarded by the document's read hook, and a one-year retention.

## Keep the versions

Turn on `events` and `history` with a one-year retention:

```ts title="quickservicets.config.ts"
import { defineConfig, memoryAdapter } from "@quickservicets/core";

export default defineConfig({
  database: memoryAdapter(),
  events: {},
  history: { retention: "365d" },
});
```

Tag the entity with `@history`, and guard its reads with a hook:

```ts title="entities/Document.ts"
/**
 * @history
 * @auditReader:read
 */
export type Document = {
  title: string;
  body: string;
  owner: string;
  /** @sensitive */
  secretNote?: string;
};
```

```bash
bun run quickservicets migration add DocumentHistory
bun run quickservicets migrate
```

## Restrict who reads them

The history routes, `GET /documents/[id]/history` and `GET /documents/[id]/history/[version]`, run the hooks of the document's read route, so one hook guards the document and its history:

```ts title="hooks/auditReader.ts"
import { definePreHook, HttpError } from "@quickservicets/core";

/** Lets the document's owner and the users with the auditor role read a document and its history. */
export default definePreHook(async (repos, req) => {
  const user = req.user as { id: string; roles?: string[] } | undefined;
  if (!user) throw new HttpError(401, "Sign in to read documents");
  if (user.roles?.includes("auditor")) return;
  const documents = (repos as unknown as { documents: { findById(id: string): Promise<{ owner: string } | null> } }).documents;
  const document = await documents.findById(req.params.id!);
  if (document?.owner !== user.id) throw new HttpError(403, "Only the owner and auditors read this document");
});
```

`req.user` is set by your authentication. An auditor now reads every version:

```bash
curl -H "authorization: Bearer <auditor token>" http://localhost:3000/documents/<id>/history
```

## Keep them for a year

The daily `history/prune` job deletes the versions older than 365 days, keeping the current version of every document that still exists. Check what it would delete with:

```bash
bun run quickservicets history prune --dry-run
```

`@history retention=7d` on another entity gives it a shorter retention, and `QS_HISTORY_RETENTION` changes the global one per environment.
