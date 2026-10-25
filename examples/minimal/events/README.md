# events

The smallest project that shows the `events` native: every write of `User` becomes a write event, an after-commit listener writes an audit entry for it, and an in-transaction listener refuses a user without an email address.

```bash
bun run test
```

## Level 0: enable

Turn the native on in `quickservice.config.ts`, then listen from a feature's setup with `ctx.events.on`:

```ts
export default defineConfig({ database: memoryAdapter(), events: {} });
```

```ts
ctx.events.on("*", async (event) => {
  await repos.auditEntries.create({ type: event.type, recordId: event.recordId, changed: event.changed });
});
```

## Level 1: options and environment

`QS_EVENTS_ENABLED=true` turns the native on without its config key, and `QS_EVENTS_ENABLED=false` turns it off:

```bash
QS_EVENTS_ENABLED=true bun .generated/server.ts
```

## Level 2: tags

Not applicable: the native has no tag yet; every entity that is not a system entity emits its write events.

## Level 3: per request

Not applicable: which events exist does not depend on the request; listeners read the request, its user and tenant through `currentOperation()`, and each event carries `actor` and `requestId`.

## Level 4: hooks and events

An `inTransaction` listener runs inside the write's transaction, and a throw rolls the write back:

```ts
ctx.events.on(
  "user.created",
  (event) => {
    if (!String(event.after?.email ?? "").includes("@")) throw new HttpError(400, "A user needs an email address");
  },
  { phase: "inTransaction" },
);
```

## Level 5: override files

Not applicable: the native ships no file a project replaces by name yet.

## Level 6: replace the implementation

Not applicable: the native has no provider option yet; a project feature with the key `events` replaces it entirely.

## Level 7: eject

Copy the native into the project as `features/events/`, which then replaces it:

```bash
bun run quickservice eject events
```
