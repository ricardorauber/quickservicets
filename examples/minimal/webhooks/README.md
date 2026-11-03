# webhooks

The smallest project that shows the `webhooks` native, both ways:

- outgoing: an `Order` entity tagged `@webhooks created,updated` and the custom event `invoice.paid` (emitted by `POST /invoices/[id]/pay`) are deliverable, and signed-in admins manage subscriptions at `/webhooks`;
- incoming: `endpoints/github/webhook.ts` verifies GitHub's signature and records each push in a `Push` entity once, and `endpoints/partner/webhook.ts` receives a partner's Standard Webhooks deliveries.

```bash
bun run test
```

The webhooks guide (`docs/src/content/docs/guides/webhooks.md`, on the site at `/guides/webhooks/`) explains every piece.

## Level 0: enable

Turn the native on (it turns on `events` and `queues` too) and create a subscription:

```ts
export default defineConfig({ database: memoryAdapter(), auth: { providers: [testAuth()] }, webhooks: {} });
```

```bash
curl -X POST localhost:3000/webhooks -H "x-test-user: ana;roles=admin" -H "content-type: application/json" \
  -d '{"url":"https://hooks.example/orders","events":["order.created"]}'
```

## Level 1: options and environment

Options change the retry schedule, and every option has a `QS_*` variable:

```ts
webhooks: { events: ["invoice.paid"], delivery: { retrySchedule: ["10s", "1m", "10m", "1h"] } }
```

```bash
QS_WEBHOOKS_DELIVERY_TIMEOUT=5s bun .generated/server.ts
```

## Level 2: tags

`@webhooks fields=…` limits what an entity's records carry, and `@webhook dedupe=false` lets one incoming route process repeated deliveries:

```ts
/** @webhooks created,updated fields=status,total */
export type Order = { status: string; total: number };
```

```ts
/** @webhook dedupe=false */
export default defineWebhook({ verify: githubSignature({ secret: env.GITHUB_WEBHOOK_SECRET }), handle: async () => {} });
```

## Level 3: per request

`delivery.headers` is computed for every attempt, and an incoming secret may depend on the request's tenant:

```ts
webhooks: { delivery: { headers: ({ tenant }) => ({ "x-tenant": tenant ?? "none" }) } }
```

```ts
verify: standardWebhookSignature({ secret: ({ tenant }) => partnerSecrets[tenant ?? "default"]! }),
```

## Level 4: hooks and events

`beforeDeliver` may change the body that is signed and sent, and the native's events tell when a subscription stops:

```ts
webhooks: { beforeDeliver: ({ body, headers }) => ({ body: { ...(body as object), source: "shop" }, headers }) }
```

```ts
events.on("webhook.subscription.disabled", (event) => console.warn("disabled", event.payload.subscriptionId, event.payload.reason));
```

## Level 5: override files

A project endpoint file at a management route's path replaces it:

```ts
// endpoints/webhooks/get.ts
export default async (repos: Repositories) => ({ data: await repos.webhookSubscriptions.query().toArray() });
```

## Level 6: replace the implementation

`sender` replaces signing and sending; this one writes each delivery to a file instead of calling the receiver:

```ts
webhooks: {
  sender: {
    async send({ subscription, body }) {
      await appendFile("deliveries.log", `${subscription.url} ${body}\n`);
      return { status: 200, durationMs: 0 };
    },
  },
}
```

## Level 7: eject

Copy the native into the project, where it replaces the shipped one:

```bash
bun run quickservicets eject webhooks
```
