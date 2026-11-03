import { boolean, duration, integer, list, object, oneOf, size, string, toggle } from "../public.ts";

/** The write operations an entity tagged `@webhooks` may deliver. */
export const WEBHOOK_OPERATIONS = ["created", "updated", "deleted"] as const;
export type WebhookOperation = (typeof WEBHOOK_OPERATIONS)[number];

/** The options of the `webhooks` native. */
export const webhooksOptions = object({
  events: list(string())
    .default([])
    .describe("Event patterns subscriptions may receive besides the write events of entities tagged @webhooks, like invoice.* or *.created; custom events are deliverable only through them."),
  entity: object({
    events: list(oneOf(WEBHOOK_OPERATIONS))
      .default([...WEBHOOK_OPERATIONS])
      .describe("The write operations an entity tagged @webhooks delivers when its tag lists none: created, updated and deleted."),
  })
    .default({})
    .describe("The defaults of entities tagged @webhooks, which the tag's options change per entity."),
  routes: toggle({
    path: string().default("/webhooks").describe("Where the subscription management routes are served."),
    roles: list(string()).default(["admin"]).describe("The roles that may manage subscriptions over HTTP; an empty list lets any signed-in user."),
  }).describe("The HTTP routes that manage subscriptions, which need the auth native."),
  delivery: object({
    timeout: duration().default("10s").describe("The longest one delivery attempt may take."),
    retrySchedule: list(duration())
      .default(["5s", "5m", "30m", "2h", "5h", "10h", "10h"])
      .describe("The delays before each retry of a failed delivery, from 1 to 20 durations of at most 7d."),
    disableAfter: duration().default("5d").describe("How long a subscription may keep failing before it is disabled."),
    responseBodyLimit: size().default("1KB").describe("How much of a receiver's response body each attempt keeps."),
    retention: duration().default("30d").describe("How long finished deliveries are kept."),
    requireHttps: boolean().optional().describe("Accepts only https subscription URLs; true in production and false otherwise by default."),
    concurrency: integer().min(1).default(10).describe("How many attempts of one subscription run at once in one process."),
  })
    .default({})
    .describe("How deliveries are sent, retried and kept."),
  incoming: object({
    tolerance: duration().default("5m").describe("How far a signed timestamp of an incoming webhook may be from now."),
    maxBodySize: size().default("1MB").describe("The largest body an incoming webhook route reads."),
    dedupe: toggle({
      retention: duration().default("7d").describe("How long receipts of processed deliveries are kept."),
    }).describe("Processes each incoming delivery id once, keeping a receipt per delivery."),
  })
    .default({})
    .describe("How incoming webhook routes (webhook.ts files) verify and process deliveries."),
});
