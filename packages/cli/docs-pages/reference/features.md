# Native features

> Every native feature of QuickService.ts, with its reference page.

| Feature | Summary | Enabled by default |
| --- | --- | --- |
| [`security`](/reference/features/security/) | Safe defaults for every service: security headers, CORS, request limits, timeouts, load shedding, rate limits, IP lists and log masking, each a switchable item. | yes |
| [`events`](/reference/features/events/) | Write events for every entity, delivered to listeners inside the write's transaction or after its commit. | no |
| [`queues`](/reference/features/queues/) | Background queues stored in the project's database, with consumers declared as files in queues/. | no |
| [`health`](/reference/features/health/) | Liveness and readiness routes for orchestrators and load balancers, checking the database, the queue and the checks features add. | no |
| [`idempotency`](/reference/features/idempotency/) | Idempotency keys: a request repeated with the same Idempotency-Key gets the first response again without running twice. | no |
| [`etag`](/reference/features/etag/) | Entity tags on record reads and writes, with 304 answers to conditional reads and 412 answers to stale conditional writes. | no |
| [`history`](/reference/features/history/) | Every version of the records of chosen entities, kept in a history table written in the same transaction as the change. | no |
| [`realtime`](/reference/features/realtime/) | Server-Sent Events endpoints from sse.ts files, with heartbeats, disconnect handling and a stream limit per worker. | no |
| [`errors`](/reference/features/errors/) | One interface that receives every unexpected error with its request, user and tenant, so a reporting service plugs in with one line. | no |
| [`flags`](/reference/features/flags/) | Feature flags turned on per user, per tenant or for a percentage of users, read synchronously in any endpoint or hook. | no |
