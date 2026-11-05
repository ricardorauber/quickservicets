# 0103 - Probe results stay in the probing process

- Date: 2026-11-05
- Spec: 0335-instance-health-and-outlier-ejection
- Status: accepted

## Context
Spec 0335 R4 runs active probes in the worker that runs scheduled work and asks to "share the results with other workers through the registry cache of spec 0334 R2". That cache is per worker (spec 0334 R2: "cached per worker for 5 seconds"), and worker processes have no channel between them, so the probing worker cannot hand its results to the others.

## Options considered
- A: Probes run in the worker that runs scheduled work and record their results in that process's instance states, which every call of that process reads; the other workers eject failing instances from their own calls. A channel between workers is left to a later spec. No extra probe traffic.
- B: Every worker probes, so each one knows. Multiplies the probe traffic by the worker count and contradicts "the worker that runs scheduled work".
- C: Share the results through the database. Adds a table and writes to a native that otherwise stores nothing.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
- With `server.workers: 1` (one process per container, the common deployment) probes cover every call.
- The guide says that other workers learn of failing instances from their own calls.
