# 0018 - An on-demand run whose run time is already taken moves 1ms later

- Date: 2026-10-19
- Spec: 0109-job-manual-triggers
- Status: accepted

## Context
Spec 0109 R1 records a `manual` run with `scheduledAt` = now and `attempt: 1`, and R4 claims `code` runs with the same
rules. Runs are claimed through the unique index on `job`, `scheduledAt` and `attempt` (spec 0105, ADR 0029), so two
on-demand runs of a job started in the same millisecond — two requests calling `req.jobs.run` at once, or a CLI run
racing one — hit the same key, and the second claim returns nothing. The spec does not say what happens then.

## Options considered
- A: Retry the claim with `scheduledAt` 1ms later until it is stored — every call gets its own run record and the
  overlap rule still decides whether it runs or is `skipped`; `scheduledAt` can be a few milliseconds after the call.
- B: Fail the call with an error — `req.jobs.run` would reject at random under load for a run nobody else holds.
- C: Return the run that holds the key — a second call would report someone else's run, which may have different
  `force` handling.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`runOnDemand()` in `packages/core/src/jobs/triggers.ts` claims and executes `manual` and `code` runs through
`JobRunner.run()`, moving the run time 1ms later while the claim returns null. `quickservice job run` and `req.jobs.run`
both use it; the CLI reads the final outcome from the latest attempt of the claimed run time, so retries recorded under
it are reported.
