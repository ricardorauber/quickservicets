# 0054 - The ring buffer of change streams listens while no stream is open

- Date: 2026-10-26
- Spec: 0207-change-stream-resume-and-fan-out
- Status: accepted

## Context
Spec 0206 R7 subscribes a change stream's entity to its write events only while a stream of it is open, so writes
cost nothing without streams. Spec 0207 R2 feeds an in-process ring buffer from an after-commit listener when the
outbox is off, so a client that reconnects gets the events it missed while it had no stream open. A buffer filled
only while streams are open would miss exactly those events, and replay would rarely work.

## Options considered
- A: With the ring buffer, listen to the covered entities' events from startup (one append per write of a covered
  entity); with the outbox, keep 0206 R7: no listener, and the log is polled only while a stream is open.
- B: Fill the buffer only while streams are open — keeps 0206 R7 everywhere, but a reconnecting client usually gets
  `reset`, which defeats R3.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
Covered entities cost one buffer append per write when the outbox is off; uncovered entities still cost nothing, and
with the outbox nothing runs per write. The 0206 test of "no listener without streams" uses the outbox source.
