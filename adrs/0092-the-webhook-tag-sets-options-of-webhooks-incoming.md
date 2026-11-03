# 0092 - The `@webhook` tag sets options of `webhooks.incoming`, which gains `async`

- Date: 2026-11-03
- Spec: 0292-webhooks-customization
- Status: accepted

## Context
Spec 0292 R3 gives `webhook.ts` files the endpoint tag `@webhook` with the options `tolerance`, `maxBodySize`, `dedupe` and `async`. Feature tags (spec 0144) set options of the feature, here the keys of one scoped object. `webhooks.incoming` already holds `tolerance`, `maxBodySize` and `dedupe` (spec 0284 R2), but no `async`, which spec 0291 R6 puts on `defineWebhook`. Spec 0292 R7 also lets a project replace `WebhookSubscription` with its own entity file, which cannot declare the JSON field `headers` that spec 0284 R4 lists, since entity files have no record type.

## Options considered
- A: Scope the tag to `incoming` and add `incoming.async` (`boolean`, default `false`, `QS_WEBHOOKS_INCOMING_ASYNC`): a route runs in the queue when `defineWebhook` or its `@webhook async=true` (or the option) says so. A project `WebhookSubscription` may leave `headers` out; subscriptions of such an entity refuse `headers` with `Is not supported by this WebhookSubscription entity`.
- B: A tag that sets no feature option and parses its own text, and a record type for entity files; both are new core mechanisms for one native.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
- `webhooks.incoming.async` is an extra option beside those of spec 0284 R2.
- `@webhook async=false` cannot turn off the `async: true` of a `defineWebhook` call; the file's own option says what it does.
- The build's check of a project `WebhookSubscription` requires every field of spec 0284 R4 except `headers`.
