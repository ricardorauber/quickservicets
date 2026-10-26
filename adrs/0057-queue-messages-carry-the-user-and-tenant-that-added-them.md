# 0057 - Queue messages carry the user and tenant of the request that added them

- Date: 2026-10-26
- Spec: 0210-error-reports-from-jobs-queues-and-startup
- Status: accepted

## Context
Spec 0210 R5 and AC5 want a failing queue consumer started by a request of user `u1` to send a report with
`user: { id: "u1" }`. Queue messages (spec 0183) kept only the request id, and consumers run in another operation
than the request, so nothing knew the user by the time the message failed. The ErrorReport type of spec 0209 also had
no place for the request id of reports outside requests.

## Options considered
- A: Store `actor: { user?, tenant? }` on each message (a JSON column of `QueueMessage`, optional in
  `QueueBrokerMessage` and `QueueReceivedMessage`, also `requestId` on received messages), and add an optional
  `requestId` to `ErrorReport` — the reports of jobs, queues and listeners then carry user, tenant and request id.
- B: Keep a per-process map of request ids to users while messages wait — lost on restart and across workers.
- C: Report queue failures without the user — fails AC5.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
Projects with the `queues` native get a new nullable `actor` column in `queue_messages` (run `migration add`); other
brokers may keep the field or drop it. Queue consumers run with the message's request id in their operation context.
