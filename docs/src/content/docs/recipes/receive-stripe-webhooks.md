---
title: Receive Stripe webhooks
description: Accept Stripe events on a signed endpoint, process each event once even when Stripe repeats it, answer fast while slow work runs in the background, and test it locally with the Stripe CLI.
sidebar:
  order: 26
---

**The problem:** Stripe tells your service that a payment succeeded by calling a URL. You must check that the call really comes from Stripe, process each event once even though Stripe retries and may send an event twice, and answer within a few seconds while the work behind it may be slow.

**The solution:** a `webhook.ts` endpoint of the [webhooks native](/guides/webhooks/#incoming-webhooks), verified with `stripeSignature`, deduplicated by the event id and handled in the background.

## 1. Enable the native and declare the secret

```ts
// quickservicets.config.ts
import { defineConfig, secret, sqliteAdapter } from "@quickservicets/core";

export default defineConfig({
  database: sqliteAdapter({ path: "data.db" }),
  env: { STRIPE_WEBHOOK_SECRET: secret() },
  webhooks: {},
});
```

`webhooks: {}` turns on `events` and `queues`. Put the endpoint's signing secret (`whsec_…`, from the Stripe dashboard or `stripe listen`) in `.env` as `STRIPE_WEBHOOK_SECRET`.

## 2. Add the endpoint

```ts
// endpoints/stripe/webhook.ts
import { defineWebhook, env, stripeSignature } from "@quickservicets/core";

type StripeEvent = { id: string; type: string; data: { object: { id: string; amount_received?: number } } };

export default defineWebhook<StripeEvent>({
  async: true,
  verify: stripeSignature({ secret: env.STRIPE_WEBHOOK_SECRET }),
  handle: async (event, ctx) => {
    if (event.type !== "payment_intent.succeeded") return;
    await ctx.repos.payments.create({ stripeId: event.data.object.id, amount: event.data.object.amount_received ?? 0 });
  },
});
```

- `stripeSignature` checks the `Stripe-Signature` header on the raw body and refuses timestamps more than five minutes away (`incoming.tolerance`); a bad signature answers 401 `Invalid webhook signature`.
- The event's `id` is the delivery id, so a repeated event answers `{ "received": true, "duplicate": true }` without running `handle` again.
- `async: true` answers 202 at once and runs `handle` in the `webhooks/incoming` queue, which retries it when it throws.

Run `quickservicets build`, then `quickservicets migration add AddWebhooks` and `quickservicets migrate` for the receipts table.

## 3. Test it locally

The Stripe CLI forwards test events to the running service and prints the secret to use:

```bash
stripe listen --forward-to localhost:3000/stripe
stripe trigger payment_intent.succeeded
```

## Notes

- Keep the endpoint's work idempotent anyway: dedupe covers repeated deliveries of one event, not two events about the same payment.
- During a secret rotation, give `secret` a list, `[env.STRIPE_WEBHOOK_SECRET, env.STRIPE_WEBHOOK_SECRET_OLD]`; a signature by either is accepted.
