# history

The smallest project that shows the `history` native: a `Document` entity whose every create, update and delete stores a version in `document_history`, in the same transaction as the write, without its `@sensitive` note, and a `Draft` entity that keeps no history.

```bash
bun run test
```

## Level 0: enable

Turn the native on (it needs `events`) and tag the entities whose versions you keep:

```ts
export default defineConfig({ database: memoryAdapter(), events: {}, history: {} });
```

```ts
/** @history */
export type Document = { title: string; body: string };
```

## Level 1: options and environment

`entities: "all"` keeps the history of every regular entity, and every option has a `QS_*` variable:

```ts
history: { entities: "all" }
```

`retention` deletes older versions every day (the current version of a live record is always kept):

```ts
history: { retention: "365d" }
```

```bash
QS_HISTORY_RETENTION=365d bun .generated/server.ts
```

## Level 2: tags

`@history off` excludes an entity (useful with `entities: "all"`); on a field, `@history off` leaves it out of versions and `@history on` keeps a `@hidden` or `@sensitive` field in them:

```ts
/** @history */
export type Document = {
  title: string;
  /** @history off */
  scratch: string;
};
```

## Level 3: per request

`retention` can be a function, called when pruning once per entity and tenant; `undefined` keeps that tenant's versions forever:

```ts
history: { retention: ({ tenant }) => (tenant === "enterprise" ? "1825d" : "90d") }
```

## Level 4: hooks and events

`beforeVersion` runs inside the write's transaction and may change or skip a version; `afterVersion` observes it after the commit:

```ts
history: {
  beforeVersion: (step) => step && { ...step, version: { ...step.version, record: { ...step.version.record, body: "[masked]" } } },
  afterVersion: ({ entity, version }) => console.debug("version", entity, version.entityId),
}
```

## Level 5: override files

The native serves `GET /documents/[id]/history` and runs the daily `history/prune` job; a project file at the same path replaces either one:

```ts
// endpoints/documents/[id]/history/get.ts
export default async (repos: Repositories, req: ServiceRequest) => repos.documentHistory.where((version) => version.entityId.eq(req.params.id!)).all();
```

## Level 6: replace the implementation

`store` replaces the history tables with any object that writes, lists, reads and prunes versions; the build then adds no history tables:

```ts
history: { store: { write, list, get, prune } }
```

## Level 7: eject

Copy the native into the project as a `features/history/` project feature that replaces it:

```bash
quickservice eject history
```
