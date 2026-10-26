---
title: Error reporting
description: Send every unexpected error, from requests, jobs, queues, events and startup, to one reporter interface with its request, user and tenant, masked, so a reporting service plugs in with one line.
sidebar:
  order: 55
---

An endpoint fails at 3 a.m. and the log has a 500 among millions of lines; nobody looks until a customer calls. The `errors` native sends every unexpected error to reporters, objects with one `report` method, like a logger receives its entries. The default writes a log entry; a reporting service plugs in with one line. The options, variables, tag, hook and feature API are listed on the [errors reference page](/reference/features/errors/).

The samples come from the example project `examples/minimal/errors`: an endpoint that throws, a job that fails and two reporters.

## The interface

```ts title="reporters.ts"
import { appendFileSync } from "node:fs";
import type { ErrorReport, ErrorReporter } from "@quickservice/core";

/** Keeps every report in memory, as the tests read them. */
export function memoryReporter(): ErrorReporter & { reports: ErrorReport[] } {
  const reports: ErrorReport[] = [];
  return { reports, report: (report) => void reports.push(report) };
}

/** Appends each report to a JSON-lines file, one report per line. */
export function jsonLinesReporter(path: string): ErrorReporter {
  return { report: (report) => appendFileSync(path, `${JSON.stringify(report)}\n`) };
}
```

An `ErrorReporter` has `report(report)`, which may return a promise, and an optional `flush(timeoutMs)` that delivers what it buffered. `errors: { reporter }` takes one reporter or a list.

```ts title="quickservice.config.ts"
import { defineConfig, memoryAdapter } from "@quickservice/core";

export default defineConfig({
  database: memoryAdapter(),
  errors: {},
});
```

## What is reported, and when

| Kind | When |
| --- | --- |
| `request` | A request ends with an error that is not an `HttpError`, or an `HttpError` of 500 or more. A 404 or a 422 is a normal answer, not a report. The response and the existing 500 log entry do not change. |
| `job` | A job run fails, times out or is abandoned and no retry follows; with `jobs: "every"`, each failed attempt. |
| `queue` | A queue message becomes dead; with `jobs: "every"`, each failed attempt too. |
| `event` | An after-commit event listener throws (`tags.event`), or an outbox delivery becomes failed (`tags.consumer` and `tags.event`). |
| `startup` | A feature set up after `errors` fails in setup or `onStart`, or the database does not connect (`tags.feature`, `tags.phase`); the process exits with 1 once the reporters flushed. |
| `manual` | Code calls `reportError(error, { tags, user, tenant, request })`, which does nothing while the native is off. |

```ts title="endpoints/boom/get.ts"
/** Fails on purpose, so the report shows up. */
export default () => {
  throw new Error("The payment provider timed out");
};
```

```ts title="jobs/sync-invoices.ts"
import { job } from "@quickservice/core";

/** Syncs invoices every night; the provider is down, so it fails on purpose. */
export default job("@daily", async () => {
  throw new Error("The invoice provider refused the connection");
});
```

## The report

A report has the error's `name`, `message` and, outside production, `stack`; its `kind`; `request` (id, method, path, matched route, the `user-agent`, `content-type` and `referer` headers and the query, never the body, cookies or `authorization`); `user` and `tenant` ids; `job` or `queue` with their attempt; the `requestId` the code ran for; `tags`; `environment`; `release`; and `at`. Jobs, queue messages and listeners carry the user, tenant and request id of the request that started them.

## Masking

Every report passes through the masking of the `security` native before any reporter sees it: known secret values become `[secret]`, `@sensitive` fields `[sensitive]`, and so do values whose names look secret, so `?token=abc` is reported as `token: "[secret]"`.

## The console reporter

Without a `reporter`, `consoleReporter()` writes each report as one `error` log entry named `error.report` through the configured logger. Keep it next to another reporter with `reporter: [consoleReporter(), myReporter]`.

## Writing a reporter

Reporters are called without being awaited on the request path: a slow reporter never delays a response. A reporter that throws or rejects is logged as `error.report.failed` with its index, and the others still get the report. A reporting service usually buffers and sends in batches; give it a `flush` that sends what is left.

## Flushing

On shutdown the native waits for the pending reports and calls `flush(timeoutMs)` of every reporter that has one, all within `lifecycle.stopTimeout`; when the time runs out it logs `error.flush.timeout` and the shutdown goes on. A startup failure flushes before the process exits.

## Customization

1. Enable: `errors: {}`.
2. Options and variables: `release`, `tags`, `jobs`, `sampleRate` (from 0 to 1, decided once per report; startup reports are never sampled out) and `ignore` (error names like `AbortError` and statuses like `"503"`, dropped before sampling), each with its variable, such as `QS_ERRORS_RELEASE=1.4.2`, `QS_ERRORS_SAMPLE_RATE=0.25` and `QS_ERRORS_ENABLED=false`.
3. Tags: `@report off` on an endpoint or an entity stops the reports of its routes, and `@report sampleRate=0.1` samples them.
4. Per request: `tags` can be a function of the request, its user and tenant; its result goes into request reports, and one that throws is logged as `error.tags.failed` without failing the request.

```ts
errors: { tags: ({ tenant }) => ({ plan: (tenant as { plan?: string } | undefined)?.plan ?? "free" }) }
```

5. Hooks: `beforeReport` runs after masking and before the reporters; it returns a changed report or `null` to drop it, and one that throws is logged as `feature.hook.failed` and drops nothing.
6. Override files: the native has no routes, jobs or entities, so no project file replaces its parts.
7. Reporters: any object with `report`, like `jsonLinesReporter("errors.jsonl")` above, or a package for a reporting service.
8. Eject: `quickservice eject errors` copies the native into `features/errors/`.

Other features reach the native with `ctx.feature("errors")`, which offers `addReporter(reporter)` and `beforeReport(fn)`, both after the config's.

## See also

- [`errors` reference](/reference/features/errors/): every option with its variable, the `@report` tag, the hook and the feature API.
- [Security](/guides/security/): the masking every report passes through.
- [Jobs](/guides/jobs/) and [Queues](/guides/queues/): the retries that decide when a failure is final.
