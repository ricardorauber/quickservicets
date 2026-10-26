# history

The smallest project that shows the `history` native: a `Document` entity whose every create, update and delete stores a version in `document_history`, in the same transaction as the write, without its `@sensitive` note, readable at `GET /documents/[id]/history`; and a `Draft` entity that keeps no history.

```bash
bun run test
```

The entity history guide (`docs/src/content/docs/guides/history.md`, on the site at `/guides/history/`) explains every piece.

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

`retention` deletes older versions every day (the current version of a live record is always kept), `entities: "all"` covers every regular entity, and every option has a `QS_*` variable:

```ts
history: { retention: "365d" }
```

```bash
QS_HISTORY_RETENTION=365d bun .generated/server.ts
```

## Level 2: tags

`@history retention=7d` gives one entity its own retention and `@history off` excludes one; on a field, `@history off` leaves it out of versions and `@history on` keeps a `@hidden` or `@sensitive` field in them:

```ts
/** @history retention=7d */
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

`store` replaces the history tables with any object that writes, lists, reads and prunes versions, like this one in memory; the build then adds no history tables:

```ts
const versions: (NewVersion & { entity: string; version: number })[] = [];
const memoryStore: HistoryStore = {
  write: (version, { entity }) => {
    const stored = { ...version, entity, version: versions.filter((v) => v.entity === entity && v.entityId === version.entityId).length + 1 };
    versions.push(stored);
    return stored;
  },
  list: async (entity, id, { limit, offset }) => {
    const found = versions.filter((v) => v.entity === entity && v.entityId === id).reverse();
    return { data: found.slice(offset, offset + limit), total: found.length };
  },
  get: async (entity, id, number) => versions.find((v) => v.entity === entity && v.entityId === id && v.version === number) ?? null,
  prune: async () => 0,
};

history: { store: memoryStore }
```

## Level 7: eject

Copy the native into the project as a `features/history/` project feature that replaces it:

```bash
quickservice eject history
```
