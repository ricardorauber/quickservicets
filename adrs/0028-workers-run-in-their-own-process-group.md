# 0028 - Worker processes run in their own process group and are told their index through the environment

- Date: 2026-10-19
- Spec: 0117-server-workers
- Status: accepted

## Context
Spec 0117 R4 has the primary forward `SIGTERM` and `SIGINT` to the workers, and R5 runs the scheduler in worker 0
only. A Ctrl+C in a terminal sends `SIGINT` to the whole foreground process group, so workers in the primary's group
would receive it twice: once from the terminal and once forwarded. The graceful shutdown handler listens for the first
signal only, so the second one would end a worker in the middle of its shutdown. The spec also does not say how a
worker learns its index.

## Options considered
- A: Start each worker in its own process group (`detached`) and pass `QS_WORKER_INDEX` and the resolved
  `QS_WORKERS` in its environment — every signal reaches a worker exactly once, through the primary, and all workers
  agree on the count even with `"auto"`; workers outlive a primary killed with `SIGKILL`, as they would anyway.
- B: Keep the workers in the primary's group and forward only signals the workers cannot have received — the primary
  cannot tell where a signal came from.
- C: Use `node:cluster` — Bun implements only part of it, and the primary would still need the same signal and restart handling.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`runWorkers()` in `packages/core/src/workers.ts` spawns the generated server again with `QS_WORKER_INDEX` (0 to
N-1); a worker that exits within a second of starting is restarted after a second, so a crash loop does not spin.
