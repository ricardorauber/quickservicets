# 0045 - The queue broker's handle resolves the consumer's result, and brokers may pause and have a name

- Date: 2026-10-25
- Spec: 0189-queue-broker-interface
- Status: accepted

## Context
Spec 0189 R1 says the `handle(message)` of a broker's start context resolves `completed` or `{ failed: error }`, but
the database broker must keep storing the consumer's return value as the message's `result` (spec 0184 R4). R1 also
lists a single `stop({ graceMs })`, while spec 0184 R8 stops claiming in `onShutdown`, before the listener closes, and
drains in `onStop`. R4's error names `The <name> queue broker`, but R1 gives brokers no name.

## Options considered
- A: `handle` resolves `{ completed: true, result }` or `{ failed: error }`; brokers may have an optional `name`
  (`database` for the default, `custom` when missing) and an optional `pause()` that the native calls in
  `onShutdown`, before `stop` drains in `onStop` — keeps every behavior of specs 0184 to 0187 and adds only optional
  members.
- B: `handle` resolves the string `completed` and results are no longer stored; `stop` both stops and drains in
  `onShutdown` — loses stored results and keeps the listener open during the drain.
- C: Keep results through a side channel (a callback passed to `handle`) — the same information in a less direct shape.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`QueueOutcome` is `{ completed: true; result?: unknown } | { failed: unknown }`; `QueueBroker` has the optional `name`
and `pause()`. Brokers that need neither ignore them. The spec could be updated to describe these members.
