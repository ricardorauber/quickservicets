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

```bash
QS_HISTORY_ENTITIES=all bun .generated/server.ts
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

Not applicable: no option is resolved per request yet.

## Level 4: hooks and events

Not applicable: the native declares no hook yet.

## Level 5: override files

Not applicable: the native contributes no routes or jobs yet.

## Level 6: replace the implementation

Not applicable: versions are stored in the history tables only so far.

## Level 7: eject

Copy the native into the project as a `features/history/` project feature that replaces it:

```bash
quickservice eject history
```
