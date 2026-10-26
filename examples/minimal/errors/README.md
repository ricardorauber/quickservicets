# errors

The smallest project that shows the `errors` native: an endpoint that throws and a job that fails, whose errors reach the configured reporter with their request, user, tenant or job, masked, while the response stays the usual 500.

```bash
bun run test
```

The error reporting guide (`docs/src/content/docs/guides/error-reporting.md`, on the site at `/guides/error-reporting/`) explains every piece.

## Level 0: enable

Turn the native on; without a reporter, each report is an `error.report` log entry:

```ts
export default defineConfig({ database: memoryAdapter(), errors: {} });
```

## Level 1: options and environment

`release` is added to every report, and every option has a `QS_*` variable:

```ts
errors: { release: "1.4.2", sampleRate: 1, ignore: ["AbortError", "503"] }
```

```bash
QS_ERRORS_RELEASE=1.4.2 bun .generated/server.ts
```

## Level 2: tags

`@report off` stops the reports of an endpoint or of an entity's routes, and `@report sampleRate=0.1` samples them:

```ts
/** @report off */
export default () => {
  throw new Error("Expected while the partner API is in maintenance");
};
```

## Level 3: per request

`tags` can be a function of the request, its user and tenant, merged into request reports:

```ts
errors: { tags: ({ tenant }) => ({ plan: (tenant as { plan?: string } | undefined)?.plan ?? "free" }) }
```

## Level 4: hooks and events

`beforeReport` changes a report after masking, or drops it with `null`:

```ts
errors: { beforeReport: (report) => (report?.error.name === "AbortError" ? null : report) }
```

## Level 5: override files

Not applicable: the native has no routes, jobs or entities, so no project file replaces any of its parts.

## Level 6: replace the implementation

`reporter` takes any object with `report(report)`, or a list of them, like the JSON-lines reporter of `reporters.ts`:

```ts
errors: { reporter: [consoleReporter(), jsonLinesReporter("errors.jsonl")] }
```

## Level 7: eject

Copy the native into the project as a `features/errors/` project feature that replaces it:

```bash
quickservicets eject errors
```
