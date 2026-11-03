# webhooks

The smallest project that shows the `webhooks` native: an `Order` entity tagged `@webhooks created,updated` and the custom event `invoice.paid` made deliverable, so subscriptions created from code may receive them.

```bash
bun run test
```

The webhooks guide (`docs/src/content/docs/guides/webhooks.md`, on the site at `/guides/webhooks/`) explains every piece.

## Level 0: enable

Turn the native on; it turns on `events` and `queues` too:

```ts
export default defineConfig({ database: memoryAdapter(), webhooks: {} });
```

```ts
const created = await webhooks.subscriptions.create({ url: "https://hooks.example/orders", events: ["order.created"] });
```

## Level 1: options and environment

`events` makes custom events deliverable, and every option has a `QS_*` variable:

```ts
webhooks: { events: ["invoice.paid"], delivery: { requireHttps: true } }
```

```bash
QS_WEBHOOKS_DELIVERY_REQUIRE_HTTPS=true bun .generated/server.ts
```

## Level 2: tags

`@webhooks` makes an entity's write events deliverable, a list limits the operations, and `@webhooks off` excludes it:

```ts
/** @webhooks created,updated */
export type Order = { status: string; total: number };
```

## Level 3: per request

Subscriptions belong to the tenant of the scope that creates them, and calls made for a tenant only see its own:

```ts
await runForTenant("acme", () => webhooks.subscriptions.create({ url: "https://hooks.example/acme", events: ["order.created"] }));
```

## Level 4: hooks and events

Not applicable: the native has no hooks yet; subscriptions follow the events the project makes deliverable.

## Level 5: override files

Not applicable: the native serves no routes yet; subscriptions are managed from code with `webhooks.subscriptions`.

## Level 6: replace the implementation

The subscriptions are records of the internal entity `WebhookSubscription`, which project code can also read and change through its repository:

```ts
const subscriptions = await repos.webhookSubscriptions.query().toArray();
```

## Level 7: eject

Not applicable: ejecting the native comes with its customization options.
