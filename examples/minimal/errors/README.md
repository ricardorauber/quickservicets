# errors

The smallest project that shows the `errors` native: an endpoint that throws, whose error reaches the configured reporter with its request, user and tenant, masked, while the response stays the usual 500.

```bash
bun run test
```

## Level 0: enable

Turn the native on; without a reporter, each report is an `error.report` log entry:

```ts
export default defineConfig({ database: memoryAdapter(), errors: {} });
```

## Level 1: options and environment

`release` and `tags` are added to every report, and every option has a `QS_*` variable:

```ts
errors: { release: "1.4.2", tags: { region: "eu" } }
```

```bash
QS_ERRORS_RELEASE=1.4.2 bun .generated/server.ts
```

## Level 2: tags

Not applicable: the native declares no tag yet.

## Level 3: per request

Not applicable: no option is resolved per request yet.

## Level 4: hooks and events

Not applicable: the native declares no hook yet.

## Level 5: override files

Not applicable: the native has no routes, jobs or entities to replace.

## Level 6: replace the implementation

`reporter` takes any object with `report(report)`, or a list of them, like the memory reporter of `reporters.ts`:

```ts
errors: { reporter: memoryReporter() }
```

## Level 7: eject

Copy the native into the project as a `features/errors/` project feature that replaces it:

```bash
quickservice eject errors
```
