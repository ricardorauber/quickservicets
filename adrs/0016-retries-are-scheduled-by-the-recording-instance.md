# 0016 - Retries are scheduled in memory by the instance that recorded the attempt, and claimed with the overlap rule

- Date: 2026-10-19
- Spec: 0107-job-timeouts-and-retries
- Status: accepted

## Context
Spec 0107 R2 starts a new attempt `retryDelay × 2^(attempt − 1)` after a `failed`, `timedOut` or `abandoned` run,
"claimed through the unique index like scheduled runs". The spec does not say which instance waits for the delay, from
when the delay counts, whether the next attempt follows the job's `overlap` rule like a scheduled run, or how a timed-out
run is reported in the service log (spec 0106 R8 logs `job.finished` at `error` level only for `failed`).

## Options considered
- A: The instance that stored the attempt's outcome (or marked it `abandoned`) arms a timer from that moment and, when
  it fires, claims the next attempt through the same `claim()` as scheduled runs, so the unique index keeps it to one
  record and the overlap rule applies (a retry falling during another running run of the job is stored `skipped`);
  `timedOut` runs log `job.finished` at `error` level like `failed` ones; `idle()` also waits for the retries already
  scheduled, so `quickservice job run` reports the last attempt — no new table or polling, one code path for every
  claim (scheduled, manual and code runs alike), and an instance stopping before the delay ends loses that retry.
- B: Store pending retries in the database and poll for due ones from every instance — survives restarts, but adds a
  status or table the spec does not have and a polling loop.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`JobRunner.retry(run)` in `packages/core/src/jobs/scheduler.ts` schedules the next attempt with the same `job`, `trigger`
and `scheduledAt`; `execute()` calls it for every outcome it stores, and the abandoned-run check (spec 0108) calls it for
the runs it marks. The delay and timeout helpers live in `packages/core/src/jobs/attempts.ts`.
