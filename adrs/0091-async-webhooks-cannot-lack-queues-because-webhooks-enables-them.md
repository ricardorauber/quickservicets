# 0091 - An `async` webhook cannot lack the queues native, because `webhooks` turns `queues` on

- Date: 2026-11-03
- Spec: 0291-incoming-webhook-dedupe-and-async-handling
- Status: accepted

## Context
Spec 0291 R6 says that `defineWebhook({ async: true, … })` without the queues native fails the build with `<file>: async webhooks need queues: {}`, and AC4 checks it. Spec 0284 R1 makes `webhooks` list `queues` in `enables`, so `webhooks: {}` turns `queues` on whenever the project has no `queues` key. The only way to have `webhooks` without `queues` is `queues: false`, and the core's feature resolution (spec 0137) refuses that configuration before the build looks at any file: `webhooks needs queues, but queues is false; remove queues: false or turn off webhooks`.

## Options considered
- A: Keep the `enables` rule. The build check of R6 stays as a guard (it would fire if the rule changed), and the configuration error is what a project with `queues: false` sees. AC4's last clause cannot be observed as written.
- B: Let `queues: false` win over `enables` for `webhooks`, so outgoing deliveries silently stop working; it breaks spec 0284 and the delivery specs.
- C: Drop `queues` from `enables`; `webhooks: {}` alone would no longer work, against spec 0284 AC1.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
- `packages/cli/src/build/build.ts` keeps the `async webhooks need queues: {}` check; the test checks the configuration error a project with `webhooks` and `queues: false` gets.
- Spec 0291 AC4 stays unchecked for that clause; the 202 answer, the consumer and the queue's retries are verified.
