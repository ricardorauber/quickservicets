# events

The smallest project that shows the `events` native: every write of `User` becomes a write event, the listener file `events/audit-log.ts` that the `audit` feature ships writes an audit entry after each commit, and an in-transaction listener refuses a user without an email address.

```bash
bun run test
```

## Level 0: enable

Turn the native on in `quickservice.config.ts`, then add a listener file to `events/`:

```ts
export default defineConfig({ database: memoryAdapter(), events: {} });
```

```ts
export default listen("user.written", async (event, { repos }) => {
  await repos.auditEntries.create({ type: event.type, recordId: event.recordId, changed: event.changed });
});
```

## Level 1: options and environment

`outbox: true` stores every event in the write's transaction, kept 7 days; every option has a `QS_*` variable, and `QS_EVENTS_ENABLED` turns the native on or off without its config key:

```ts
export default defineConfig({ database: memoryAdapter(), events: { outbox: true } });
```

```bash
QS_EVENTS_OUTBOX_RETENTION=1d bun .generated/server.ts
```

## Level 2: tags

`@events off` stops every event of an entity, so its writes keep their plain statements, and `@events outbox=false` keeps its events in process but out of the outbox:

```ts
/** @events off */
export type Session = { token: string };
```

## Level 3: per request

Not applicable: which events exist does not depend on the request; listeners read the request, its user and tenant through `currentOperation()`, and each event carries `actor` and `requestId`.

## Level 4: hooks and events

A `beforeEmit` hook may change or drop an event before any listener or the outbox sees it:

```ts
events: { beforeEmit: (event) => (event?.type === "user.updated" && event.changed.join() === "lastSeenAt" ? null : undefined) }
```

An `inTransaction` listener runs inside the write's transaction, and a throw rolls the write back:

```ts
ctx.events.on(
  "user.created",
  (event) => {
    if (!event.after.email.includes("@")) throw new HttpError(400, "A user needs an email address");
  },
  { phase: "inTransaction" },
);
```

## Level 5: override files

A project file in `events/` replaces a feature's listener file of the same name, and the build prints an `Override:` line:

```ts
// events/audit-log.ts replaces features/audit/events/audit-log.ts
export default listen("user.written", () => undefined);
```

## Level 6: replace the implementation

A custom `bus` replaces the in-process after-commit dispatch, while in-transaction listeners and the outbox stay in the native:

```ts
events: { bus: { publish: (event) => broker.send(event), subscribe: (pattern, listener) => broker.on(pattern, listener) } }
```

## Level 7: eject

Copy the native into the project as `features/events/`, which then replaces it:

```bash
bun run quickservice eject events
```
