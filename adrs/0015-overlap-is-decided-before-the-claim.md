# 0015 - A run's overlap is decided before its claim, so skipped runs are inserted as `skipped`

- Date: 2026-10-19
- Spec: 0106-job-scheduler
- Status: accepted

## Context
Spec 0106 R2 claims each run by inserting a `JobRun` through the unique index, and R3 says that with `overlap: "skip"`
and a `running` run of the job, "the claimed record SHALL be stored with status `skipped`". The spec does not say
whether the record is inserted as `running` and then changed to `skipped`, or inserted directly with its final status.
It also does not say which log entries a skipped run writes (R8 asks for `job.started` and `job.finished` per run), or
whether the line added for an unstored result (R7) counts against `jobs.limits.logLines` (R6).

## Options considered
- A: Look for a `running` run of the job first, then insert the record with its final status (`running`, or `skipped`
  with `startedAt` = `finishedAt` = now and `durationMs: 0`); a skipped run writes both log entries with status
  `skipped`; the unstored-result line is an ordinary run log line, counted against the limit and also written to the
  service logger — no record is ever briefly `running` without a closure behind it, so other instances' overlap checks
  and the abandoned-run check (spec 0108) never see a phantom run.
- B: Insert as `running`, then check and update to `skipped` — two writes per skipped run, and a short window where
  another instance sees a `running` record that will never run or heartbeat.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`createJobRunner().claim()` in `packages/core/src/jobs/scheduler.ts` takes `{ job, trigger, scheduledAt, attempt,
force? }`, checks the overlap (unless `force`), and returns the inserted record, or null when the unique index rejects
the insert. Retries (spec 0107), abandoned-run retries (spec 0108) and manual/code triggers (spec 0109, `force` for
`--force`) claim through it and execute through `execute()`/`run()`, the same recording path as scheduled runs.
