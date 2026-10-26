# Entity history

> Keep every version of the records of chosen entities, with who changed them and when, read them over HTTP, and prune them when the retention passes.

A customer says the contract changed without their consent; support needs to know who changed it, when, and what it said before. The `history` native keeps every version of the records of the entities you choose, written in the same transaction as the change, and serves them over HTTP with the same permissions as the record. The options, variables, tag, hooks, command and job are listed on the [history reference page](/reference/features/history/).

The samples come from the example project `examples/minimal/history`: a `Document` entity that keeps its history, with a `@sensitive` note left out of it, and a `Draft` entity that keeps none.

## What history stores, and when

With `history: {}` (it needs [`events`](/guides/events/)), every create, update and delete of a covered entity stores one version, written by an `inTransaction` event listener inside the write's own transaction: a rolled-back write stores no version, and a version that cannot be written fails the write. Records changed indirectly, like those deleted by `@onDelete cascade`, cleared by `setNull`, pulled from reference arrays or touched by relation sync, get their versions too.

```ts title="quickservicets.config.ts"
import { defineConfig, memoryAdapter } from "@quickservicets/core";

export default defineConfig({
  database: memoryAdapter(),
  events: {},
  history: {},
});
```

```ts title="entities/Document.ts"
/** @history */
export type Document = {
  title: string;
  body: string;
  /** @sensitive */
  secretNote?: string;
};
```

```ts title="entities/Draft.ts"
export type Draft = { text: string };
```

Each version has:

| Field | Value |
| --- | --- |
| `entityId` | The id of the record. |
| `version` | 1 for the first version of the record, one more for each later one. |
| `operation` | `create`, `update` or `delete`. |
| `actor` | Who made the write (see below). |
| `tenant`, `requestId` | The tenant's id and the request id, when the write had them. |
| `at` | The time of the write. |
| `record` | The record after the write; for a delete, the record before it. |
| `changed` | The top-level fields the write changed, `updatedAt` left out. |

## Tables

Each covered entity gets a read-only system entity `<Entity>History`, stored in `<entity>_history` (`Document` → `document_history`, `OrderItem` → `order_item_history`) with a unique index on `entityId` and `version` and an index on `entityId` and `at`. It has no generated routes and no API docs; code reads it with `repos.documentHistory`. Run `quickservicets migration add` after enabling the native or covering a new entity.

## Actors

`actor` is `user:<id>` when the request that made the write has a user with an `id`, otherwise `job:<name>` for a job run, `queue:<name>` for a queue message, and `system` for anything else, like a script or a migration.

## Covered entities and fields

An entity is covered when it has `@history`. With `entities: "all"`, every regular entity is covered unless it says `@history off`; system entities, link entities and `@internal` entities are covered only when tagged.

Versions leave out the fields tagged `@history off`, and the fields tagged `@hidden` or `@sensitive`, unless they are tagged `@history on`:

```ts
/** @history */
export type Account = {
  email: string;
  /** @hidden */
  passwordHash: string;
  /**
   * @hidden
   * @history on
   */
  recoveryCode: string;
};
```

## Routes and permissions

Every covered entity with generated routes gets two routes:

- `GET /documents/[id]/history` answers `{ data, total, limit, offset }`, newest version first. It takes `limit` (default 20, at most 100), `offset`, `where[operation][eq|in]`, `where[at][gt|gte|lt|lte]` and `where[actor][eq|in]`; any other parameter answers 400 naming it. A record without versions answers 404 `Document not found`, and a deleted record's versions stay readable.
- `GET /documents/[id]/history/[version]` answers one version, 404 `Document version 9 not found` when it does not exist, and 400 when the version is not a positive integer.

Both routes run the hooks of the entity's read route (`GET /documents/[id]`) with the same `req.params.id`, so whoever may not read a record may not read its history. The always-hidden fields of the entity are removed from every `record` in a response, even those `@history on` keeps in the table. `@internal` entities get no routes; their versions stay readable through their repository.

## Retention and pruning

Versions are kept forever by default. Data-protection rules such as the LGPD or the GDPR may require deleting personal data after a time, so set a retention when versions hold it:

```ts
history: { retention: "365d" }
```

The daily job `history/prune` (one run across instances) deletes the versions older than the retention, in batches of 1000, logging `history.pruned` per entity and returning the counts as its result. The current version of a live record is always kept, so the last known state of every record survives; all versions of a deleted record go once they pass the retention. `quickservicets history prune` does the same from the CLI, `--entity Document` limits it to one entity and `--dry-run` only prints what would be deleted.

## Customization

Each level of the example's README, from the simplest:

1. Enable: `history: {}` and `@history` on the entities.
2. Options and variables: `retention: "365d"`, `entities: "all"`, and their variables such as `QS_HISTORY_RETENTION=365d` and `QS_HISTORY_ENABLED=false`.
3. Tags: `@history retention=7d` on one entity wins over the global retention, `@history off` excludes an entity, and on a field it leaves the field out.
4. Per tenant: `retention` can be a function, called when pruning once per entity and tenant found in its versions; `undefined` keeps that tenant's versions forever.

```ts
history: { retention: ({ tenant }) => (tenant === "enterprise" ? "1825d" : "90d") }
```

5. Hooks: `beforeVersion` runs inside the write's transaction with `{ entity, version, event }`; it may return a changed step, for example with a field masked, or `null` to skip the version, and a throw fails the write. `afterVersion` observes each version after the commit, with failures logged.

```ts
history: {
  beforeVersion: (step) => step && { ...step, version: { ...step.version, record: { ...step.version.record, body: "[masked]" } } },
}
```

6. Override files: a project endpoint at a history route's path, like `endpoints/documents/[id]/history/get.ts`, replaces it for that entity, and `jobs/history/prune.ts` replaces the prune job; the build prints an `Override:` line for each.

```ts
// endpoints/documents/[id]/history/get.ts
export default async (repos: Repositories, req: ServiceRequest) => repos.documentHistory.where((version) => version.entityId.eq(req.params.id!)).toArray();
```

7. A store: `store` replaces the tables with any object that has `write`, `list`, `get` and `prune`, such as one that archives versions to object storage; the build then adds no history tables.
8. Eject: `quickservicets eject history` copies the native into `features/history/` as a project feature that replaces it.

Other features reach the native with `ctx.feature("history")`, which offers `beforeVersion(fn)`, `afterVersion(fn)` and `versions(entity, id, { limit, offset })`.

## The cost on writes

Writes of covered entities read the record before the write (the events native does that for every observed entity) and add one read of the latest version number and one insert to the same transaction. Writes of entities that are not covered add nothing: the native listens only to the covered entities' events. With the native off, there is no listener and no table.

## Removing history

Remove `history` from the config (or set `history: false`) and run `quickservicets migration add`: the history tables are no longer part of the model, so the migration drops them with their versions. Export what you must keep first.

## See also

- [`history` reference](/reference/features/history/): every option with its variable, the `@history` tag, the hooks, the command, the job and the feature API.
- [An audit trail](/recipes/audit-trail/): one entity's history, restricted to its owner and auditors, kept for a year.
- [Events](/guides/events/): the write events history is built on.
