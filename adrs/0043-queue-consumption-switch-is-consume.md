# 0043 - Queue consumption per process is the `consume` option, not `enabled`

- Date: 2026-10-25
- Spec: 0183-queue-declarations-and-enqueue
- Status: accepted

## Context
Spec 0183 R1 lists an `enabled` option of the `queues` native meaning "whether this process consumes", and specs 0184
(R1, AC1) and 0190 (AC3) expect `QS_QUEUES_ENABLED=false` to stop the consumers of a process while `add` keeps working.
The feature contract (spec 0136 R4, spec 0139 R9) already gives every feature an implicit `enabled` option that cannot
be declared, and `<key>: { enabled: false }` or `QS_<KEY>_ENABLED=false` turns the whole feature off: no setup, no
`add`, no request property. Both meanings cannot share one option.

## Options considered
- A: Keep the contract's `enabled` (and `QS_QUEUES_ENABLED`) for the whole native, and add the option `consume`
  (`boolean().default(true)`, `QS_QUEUES_CONSUME`) that only decides whether the process runs consumers, as the
  `events` native's `outbox.dispatch` does for its dispatcher — consistent with every other native; the ACs that stop
  consumers with `QS_QUEUES_ENABLED=false` are checked with `QS_QUEUES_CONSUME=false`.
- B: Special-case the `queues` native so its `enabled: false` keeps the native running without consumers — breaks the
  contract that `QS_<KEY>_ENABLED=false` turns any native off, and needs an exception in feature resolution.
- C: Read the switch from `jobs.enabled` — couples queues to the scheduler, which a deployment may turn off separately.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
The `queues` native declares `consume` with spec 0183; spec 0184 starts no consumer loop when it is false, and
`QS_QUEUES_ENABLED=false` keeps turning the whole native off. Spec 0184 AC1 and spec 0190 AC3 are verified with
`QS_QUEUES_CONSUME=false`; the specs could be updated to name `consume`.
