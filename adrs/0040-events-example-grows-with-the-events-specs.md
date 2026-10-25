# 0040 - The events example starts with the native and grows with its specs

- Date: 2026-10-25
- Spec: 0161-write-events
- Status: accepted

## Context
Spec 0161 registers the `events` native. From spec 0158 on, the repository test requires every registered native to
have a complete `examples/minimal/<key>` workspace, with the eight README levels and an end-to-end test. The events
example is spec 0167, six specs later, so the check would fail on every spec from 0161 to 0166, and each spec must leave
the suite green.

## Options considered
- A: Add `examples/minimal/events` with spec 0161, showing what exists at that point (a listener from a feature's setup,
  an in-transaction veto, `QS_EVENTS_ENABLED`, eject) and `Not applicable:` lines for the levels later specs add; the
  following specs extend it, and spec 0167 brings it to its final content and guide.
- B: Let the check skip natives without an example until a later spec — weakens spec 0158 and needs an exception list.
- C: Register the native only in spec 0167 — breaks specs 0161 to 0166, which build and test the native.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`examples/minimal/events` exists from spec 0161 with a `Post`-less first version (users and an audit entry); spec 0167
rewrites it with the `Post` and `Comment` entities, the listener files, the outbox and the guide it specifies.
