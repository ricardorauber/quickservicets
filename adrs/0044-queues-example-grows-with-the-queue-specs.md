# 0044 - The queues example starts with the native and grows with its specs

- Date: 2026-10-25
- Spec: 0183-queue-declarations-and-enqueue
- Status: accepted

## Context
Spec 0183 registers the `queues` native. The repository test of spec 0158 requires every registered native to have a
complete `examples/minimal/<key>` workspace, with the eight README levels and an end-to-end test started with
`startTestService`. The queues example is spec 0191, eight specs later, so the check would fail on every spec from 0183
to 0190, and each spec must leave the suite green.

## Options considered
- A: Add `examples/minimal/queues` with spec 0183, showing what exists at that point (`queues: {}`, a consumer file, an
  endpoint calling `req.queue.add`, options and their variables, eject) and `Not applicable:` lines for the levels later
  specs add; spec 0191 brings it to its final content and guide. This is what ADRs 0040 and 0041 chose for the events
  and security examples.
- B: Let the check skip natives without an example until a later spec: weakens spec 0158 and needs an exception list.
- C: Register the native only in spec 0191: breaks specs 0183 to 0190, which build and test the native.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`examples/minimal/queues` exists from spec 0183 with a `User` entity, `queues/send-email.ts` and
`POST /users/[id]/welcome`; spec 0191 rewrites it with the entities, consumers, feature and README snippets per level it
specifies.
