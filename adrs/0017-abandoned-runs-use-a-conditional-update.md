# 0017 - Abandoned runs are marked with a conditional `updateById`, and shutdown rejects new claims and then exits with 0

- Date: 2026-10-19
- Spec: 0108-job-heartbeats-and-shutdown
- Status: accepted

## Context
Spec 0108 R2 marks stale `running` records as `abandoned` with an update that "SHALL only apply to records still
`running`, so two instances never both mark one", but the database adapters only had an unconditional `updateById`.
The spec also does not say which timeout applies to a record whose job was removed from the registry, what claims made
during the shutdown grace (scheduled ticks, retries, `req.jobs.run`, `quickservice job run`) do, or what exit code the
server uses once the shutdown ends.

## Options considered
- A: Give `DatabaseAdapter.updateById` an optional `where` (conditions checked in the same atomic statement: `UPDATE
  ... WHERE id = ? AND ...` on SQLite and PostgreSQL, a filtered `updateOne` on MongoDB, a check on memory) and mark
  with `status = running`; a record of a removed job uses `jobs.timeout` and is marked but not retried; once the
  shutdown starts, `claim()`/`run()` reject with `Job runs are not started while the server shuts down`, pending
  retries are canceled, the abandoned-run check stops, and the server exits with 0 (1 when the shutdown itself fails);
  a second signal waits for the same shutdown — one atomic write per mark on every database, and no endless loop in
  on-demand runs, which treat a null claim as a taken run time.
- B: Read the record in a transaction with `lockForUpdate` and then update — `lockForUpdate` exists only on
  PostgreSQL, so SQLite and MongoDB would need their own locking and the guarantee would differ per database.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`updateById(entity, id, changes, where?)` in `packages/core/src/adapter.ts` and the four built-in adapters, covered by
the adapter contract tests. `JobRunner.markAbandoned()` and `JobRunner.shutdown(graceMs)` in
`packages/core/src/jobs/scheduler.ts`; heartbeats, the once-a-minute check (`createAbandonedRunMonitor`) and
`handleShutdownSignals` in `packages/core/src/jobs/lifecycle.ts`. `createApp` returns `abandonedRuns` and `shutdown()`;
its `scheduler` starts and stops the check with the run cleanup, and the generated server calls
`handleShutdownSignals(shutdown)` after `scheduler.start()`.
