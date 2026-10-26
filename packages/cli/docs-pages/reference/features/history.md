# history

> Every version of the records of chosen entities, kept in a history table written in the same transaction as the change.

Every version of the records of chosen entities, kept in a history table written in the same transaction as the change.

## Enabling

Turn it on in `quickservicets.config.ts`:

```ts
history: {}
```

It is not enabled by default: turn it on with `history: {}` or `QS_HISTORY_ENABLED=true`, and off with `history: false` or `QS_HISTORY_ENABLED=false`.

**Requires:** [`events`](/reference/features/events/)

## Options

| Key | Type | Default | Environment variable | Per request | Description |
| --- | --- | --- | --- | --- | --- |
| `history.entities` | `"tagged" \| "all"` | `"tagged"` | `QS_HISTORY_ENTITIES` | no | Which entities keep history: tagged keeps it for entities tagged @history, all for every regular entity without @history off. |
| `history.retention` | `duration` | — | `QS_HISTORY_RETENTION` | yes | How long versions are kept, like 365d; the current version of a live record is always kept, and without it versions are kept forever. A function of the entity and tenant decides per tenant when pruning. |
| `history.beforeVersion` | `hook` | — | not overridable | no | Runs inside the write's transaction before each version is written, with the entity, the version and the event; it may return a changed step or null to skip the version, and a throw fails the write. |
| `history.afterVersion` | `hook` | — | not overridable | no | Runs after the write committed, with the entity, the stored version and the event; failures are logged. |
| `history.store` | `HistoryStore` | — | not overridable | no | Replaces the history tables: it writes, lists, reads and prunes versions, and the build adds no history entities. |
| `history.enabled` | `boolean` | `true` | `QS_HISTORY_ENABLED` | no | Turns the feature off when false. |

## Tags

### `@history`

`@history` on an entity keeps its versions, `@history retention=7d` sets how long, and `@history off` excludes it; on a field, `@history off` leaves it out of versions and `@history on` keeps a `@hidden` or `@sensitive` field in them.

**Applies to:** entities, fields

**Syntax:** `@history [retention=…]` or `@history off`

**Options:** `history.retention`

```ts
/** @history retention=90d */
export type Contract = {
  title: string;
  /** @history off */
  draftNotes: string;
};
```

## Commands

### `history prune`

Deletes the versions older than their entity's retention, keeping the current version of every live record, and prints the count per entity.

```bash
quickservicets history prune [--entity <Name>] [--dry-run]
```

**Flags:**

- `--entity` (`string`): Prunes only this entity.
- `--dry-run` (`boolean`, default `false`): Prints what would be deleted without deleting it.

## Jobs

Jobs run while the feature is enabled; a project file `jobs/<name>.ts` replaces one.

| Job | Schedule | Description |
| --- | --- | --- |
| `history/prune` | `@daily` | Deletes, every day, the versions older than the retention of their entity; one run across instances. |

## Hooks

Hooks are functions (or lists of functions) written in the config; `before` hooks may change the value or cancel the step by throwing, `after` and `on` hooks observe.

| Hook | Kind | Description |
| --- | --- | --- |
| `history.beforeVersion` | before | Runs inside the write's transaction before each version is written, with the entity, the version and the event; it may return a changed step or null to skip the version, and a throw fails the write. |
| `history.afterVersion` | after | Runs after the write committed, with the entity, the stored version and the event; failures are logged. |

## Feature API

Other features reach it with `ctx.feature("history")` in their setup, listing `history` in `requires` or `after`.

### `beforeVersion`

```ts
beforeVersion(fn: FeatureHook<HistoryVersionStep | null, undefined>): void;
```

Appends a `beforeVersion` hook after the config's; it may return a changed step or null to skip the version.

### `afterVersion`

```ts
afterVersion(fn: FeatureHook<HistoryWrittenVersion, undefined>): void;
```

Appends an `afterVersion` hook after the config's; it observes each version once its write committed.

### `versions`

```ts
versions(entity: string, id: string, page?: { limit?: number; offset?: number }): Promise<HistoryVersion[]>;
```

The versions of a record, newest first, read through the store (default limit 20, offset 0).
