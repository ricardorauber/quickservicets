import { boolean, duration, hook, integer, list, object, oneOf, provider, record, size, string, toggle } from "../public.ts";
import type { AfterDeliver, AfterHandle, BeforeDeliver, BeforeHandle, OnDisabled, WebhookSender } from "./api.ts";

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
    fields: list(string()).optional().describe("The only fields, with id, a delivered record of a tagged entity carries; all but hidden and sensitive fields without it."),
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
    headers: record(string().describe("A header value."))
      .perRequest()
      .describe("More headers of every attempt, under the subscription's own; a function of the subscription, the event and the tenant computes them per attempt."),
  })
    .default({})
    .describe("How deliveries are sent, retried and kept."),
  incoming: object({
    tolerance: duration().default("5m").describe("How far a signed timestamp of an incoming webhook may be from now."),
    maxBodySize: size().default("1MB").describe("The largest body an incoming webhook route reads."),
    dedupe: toggle({
      retention: duration().default("7d").describe("How long receipts of processed deliveries are kept."),
    }).describe("Processes each incoming delivery id once, keeping a receipt per delivery."),
    async: boolean().default(false).describe("Runs the handle of every webhook route in the webhooks/incoming queue; defineWebhook's async and a route's @webhook async= win."),
  })
    .default({})
    .describe("How incoming webhook routes (webhook.ts files) verify and process deliveries."),
  beforeDeliver: hook<BeforeDeliver, undefined>().describe(
    "Runs before each attempt with the subscription, the delivery, the body and the headers; it may return a changed body or headers, and a throw ends the delivery failed without retries.",
  ),
  afterDeliver: hook<AfterDeliver, undefined>().describe("Runs after each attempt with the subscription, the delivery, the status, whether it succeeded and the duration."),
  onDisabled: hook<OnDisabled, undefined>().describe("Runs after a subscription is disabled, with it and the reason."),
  beforeHandle: hook<BeforeHandle, undefined>().describe("Runs before the handle of an incoming webhook with the event and its context; it may return a changed event, and an HttpError is answered."),
  afterHandle: hook<AfterHandle, undefined>().describe("Runs after the handle of an incoming webhook with the event, its context, the duration and the error, when it threw."),
  sender: provider<WebhookSender>("WebhookSender", ["send"])
    .optional()
    .describe("Replaces signing and sending: `send({ subscription, delivery, body, headers, signal })` resolves `{ status, body?, durationMs }`; scheduling, retries, disabling, the log and events stay."),
});
