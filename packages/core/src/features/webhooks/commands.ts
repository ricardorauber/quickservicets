import { existsSync } from "node:fs";
import { join } from "node:path";
import { boolean, databaseBroker, defineCommand, integer, object, queueMessageEntity, string, type CommandContext, type EntityModel, type QueueBroker } from "../public.ts";
import type { WebhookDelivery } from "./deliveries.ts";
import { deliveryLog } from "./log.ts";
import { DELIVER_QUEUE } from "./matching.ts";
import { webhookDeliveryEntity } from "./deliveries.ts";
import { webhookSubscriptionEntity } from "./models.ts";
import type { StoredSubscription } from "./subscriptions.ts";

/** The models of the last build, or the native's own when there is none. */
async function modelsOf(cwd: string): Promise<{ subscription: EntityModel; delivery: EntityModel }> {
  const file = join(cwd, ".generated/models.ts");
  const models = existsSync(file) ? ((await import(file)) as { models: EntityModel[] }).models : [];
  return {
    subscription: models.find((model) => model.key === "WebhookSubscription") ?? webhookSubscriptionEntity(),
    delivery: models.find((model) => model.key === "WebhookDelivery") ?? webhookDeliveryEntity(),
  };
}

/** Connects and returns what the commands read: the subscriptions, the delivery log and a way to enqueue attempts. */
async function connected(ctx: CommandContext<unknown, unknown>) {
  await ctx.connect();
  const { subscription, delivery } = await modelsOf(ctx.cwd);
  const adapter = ctx.config.database;
  const logger = ctx.config.logger ?? { info() {}, warn() {}, error() {} };
  const log = deliveryLog({ adapter, model: delivery, logger: { info() {}, warn: logger.warn, error: logger.error } });
  const queuesOptions = ctx.config.features.find((feature) => feature.key === "queues")?.options as { broker?: QueueBroker } | undefined;
  const broker = queuesOptions?.broker ?? databaseBroker({ adapter, model: queueMessageEntity(), logger });
  const stored = async (id: string) => (await adapter.findById(subscription, id)) as unknown as StoredSubscription | null;
  /** Resends one delivery as the native's `resend` does; throws its messages. */
  const resend = async (id: string) => {
    const found = await log.get(id);
    if (!found) throw new Error(`Webhook delivery ${id} not found`);
    const owner = await stored(String(found.subscription));
    if (!owner?.enabled) throw new Error("Subscription is disabled");
    await log.reset(found);
    await broker.enqueue(
      { queue: DELIVER_QUEUE, payload: found.id, runAt: new Date(), priority: 0, maxAttempts: 1, dedupeKey: `${found.id}:resend:${Bun.randomUUIDv7()}`, ...(found.tenant ? { tenant: found.tenant } : {}) },
      { transactional: false },
    );
  };
  return { adapter, subscription, delivery, log, stored, resend };
}

/** A URL without its credentials, path query or fragment: the host only. */
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "-";
  }
};
const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : "-");

const list = defineCommand({
  name: "webhooks list",
  usage: "quickservicets webhooks list",
  description: "Prints each webhook subscription with its id, URL host, whether it is enabled, its tenant, failingSince and its deliveries per status over the last 24 hours.",
  async run(ctx) {
    const { adapter, subscription, log } = await connected(ctx);
    const { data } = await adapter.findMany(subscription, { where: [], sort: [{ field: "createdAt", direction: "asc" }], limit: 10_000, offset: 0, withTotal: false });
    const since = new Date(Date.now() - 86_400_000);
    if (data.length === 0) ctx.output.log("No webhook subscriptions");
    for (const row of data as unknown as StoredSubscription[]) {
      const counts = await log.counts(row.id, since);
      const tally = Object.entries(counts).map(([status, count]) => `${status}=${count}`).join(" ");
      ctx.output.log(`${row.id} ${hostOf(row.url)} ${row.enabled ? "enabled" : "disabled"} tenant=${row.tenant ?? "-"} failingSince=${iso(row.failingSince)} ${tally}`);
    }
    return 0;
  },
});

const deliveries = defineCommand({
  name: "webhooks deliveries",
  usage: "quickservicets webhooks deliveries <subscription> [--status <status>] [--limit <n>]",
  description: "Prints the deliveries of a subscription, newest first, with their type, status, attempt and last outcome.",
  args: [{ name: "subscription", required: true, description: "The subscription's id." }],
  flags: object({
    status: string().optional().describe("Only deliveries with this status: pending, delivering, succeeded or failed."),
    limit: integer().min(1).max(100).default(20).describe("How many deliveries to print."),
  }),
  async run(ctx) {
    const { stored, log } = await connected(ctx);
    const id = ctx.args.subscription!;
    if (!(await stored(id))) {
      ctx.output.error(`Webhook subscription ${id} not found`);
      return 1;
    }
    let page;
    try {
      page = await log.list(id, { limit: ctx.flags.limit, ...(ctx.flags.status ? { status: ctx.flags.status } : {}) });
    } catch (error) {
      ctx.output.error((error as Error).message === "Invalid query" ? `Invalid --status ${ctx.flags.status}` : (error as Error).message);
      return 1;
    }
    if (page.data.length === 0) ctx.output.log("No deliveries");
    for (const row of page.data as WebhookDelivery[]) {
      ctx.output.log(`${row.id} ${row.type} ${row.status} attempt=${row.attempt} lastStatus=${row.lastStatus ?? "-"} ${iso(row.createdAt)}${row.lastError ? ` ${row.lastError}` : ""}`);
    }
    return 0;
  },
});

const resend = defineCommand({
  name: "webhooks resend",
  usage: "quickservicets webhooks resend <delivery> | --subscription <id> --failed",
  description: "Sends a finished delivery again, or every failed delivery of a subscription, and prints how many were rescheduled.",
  args: [{ name: "delivery", description: "The delivery's id." }],
  flags: object({
    subscription: string().optional().describe("Resends deliveries of this subscription, with --failed."),
    failed: boolean().default(false).describe("With --subscription, resends every failed delivery."),
  }),
  async run(ctx) {
    const { stored, log, resend: send } = await connected(ctx);
    const count = (n: number) => `Rescheduled ${n} ${n === 1 ? "delivery" : "deliveries"}`;
    try {
      if (ctx.args.delivery !== undefined) {
        await send(ctx.args.delivery);
        ctx.output.log(count(1));
        return 0;
      }
      if (ctx.flags.subscription === undefined || !ctx.flags.failed) {
        ctx.output.error("Usage: quickservicets webhooks resend <delivery> | --subscription <id> --failed");
        return 2;
      }
      const subscription = await stored(ctx.flags.subscription);
      if (!subscription) throw new Error(`Webhook subscription ${ctx.flags.subscription} not found`);
      if (!subscription.enabled) throw new Error("Subscription is disabled");
      let rescheduled = 0;
      for (const id of await log.failedOf(subscription.id)) {
        await send(id);
        rescheduled++;
      }
      ctx.output.log(count(rescheduled));
      return 0;
    } catch (error) {
      ctx.output.error((error as Error).message);
      return 1;
    }
  },
});

/** The commands of the `webhooks` native. */
export const webhooksCommands = [list, deliveries, resend];
