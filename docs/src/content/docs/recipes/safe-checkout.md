---
title: A safe checkout
description: A checkout endpoint that a mobile client retries on a flaky network without ever charging twice.
sidebar:
  order: 24
---

**The problem:** a mobile app calls `POST /checkout`, the train enters a tunnel, and the request times out. Did the card get charged? Retrying blindly may charge twice; giving up may lose the order.

**The solution:** the client sends an [idempotency key](/guides/idempotency/) with the checkout and every retry of it. The service runs the checkout once and answers every retry with the first response.

## The service

Turn the native on and require a key on the checkout endpoint:

```ts title="quickservice.config.ts"
import { defineConfig, sqliteAdapter } from "@quickservice/core";

export default defineConfig({
  database: sqliteAdapter({ path: "data.db" }),
  idempotency: {},
});
```

```ts title="endpoints/checkout/post.ts"
import type { Repositories, ServiceRequest, ServiceResponse } from "@quickservice/core";
import { charge } from "../../payments.ts";

/** @idempotent required=true ttl=48h */
export default async (repos: Repositories, req: ServiceRequest, res: ServiceResponse) => {
  const { cartId, card } = (await req.json()) as { cartId: string; card: string };
  const cart = await repos.carts.findById(cartId);
  const payment = await charge(card, cart.total);
  const order = await repos.orders.create({ cartId, paymentId: payment.id, total: cart.total });
  res.status(201).header("location", `/orders/${order.id}`);
  return order;
};
```

```bash
bun run quickservice migration add IdempotencyKeys
bun run quickservice migrate
```

## The client

The client creates one key per checkout, keeps it until it gets an answer, and retries with it:

```ts
async function checkout(cartId: string, card: string): Promise<unknown> {
  const key = crypto.randomUUID();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch("https://shop.example.com/checkout", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({ cartId, card }),
      });
      if (response.status === 409) {
        // The first attempt is still running: wait and ask again with the same key.
        await Bun.sleep(Number(response.headers.get("retry-after") ?? 1) * 1000);
        continue;
      }
      if (response.status >= 500) throw new Error(`Server error ${response.status}`);
      return response.json();
    } catch {
      await Bun.sleep(2 ** attempt * 500);
    }
  }
  throw new Error("Checkout failed; try again later");
}
```

A retry after the charge went through gets `201` with the same order and `Idempotent-Replayed: true`; a retry while it still runs gets `409`; and the card is charged once.

## See also

- [Idempotency keys](/guides/idempotency/): scope, replays, expiry, hooks and stores.
- [Send an email in the background](/recipes/send-email-in-the-background/): the confirmation email of the order, with a queue.
