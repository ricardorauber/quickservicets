import { boolean, defineCommand, object, string, type CommandContext, type Condition, type DatabaseAdapter, type StoredRecord } from "../public.ts";
import { DELIVERY_STATUSES, outboxDeliveryEntity } from "./delivery.ts";

type EventsOptions = { outbox?: { enabled?: boolean } };

/** Connects to the database and returns the adapter, or fails when the outbox is off. */
async function connected(ctx: CommandContext<unknown, unknown>): Promise<DatabaseAdapter> {
  if (!(ctx.options as EventsOptions).outbox?.enabled) throw new Error("The outbox is not enabled; set events: { outbox: true } in quickservicets.config.ts");
  await ctx.connect();
  return ctx.config.database;
}

/** Every delivery row matching `where`, read in pages. */
async function rowsWhere(adapter: DatabaseAdapter, where: Condition[]): Promise<StoredRecord[]> {
  const model = outboxDeliveryEntity();
  const rows: StoredRecord[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data } = await adapter.findMany(model, { where, sort: [{ field: "id", direction: "asc" }], limit: 1000, offset, withTotal: false });
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

/** A duration in seconds as `1h 2m 3s`. */
function age(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const parts = [[Math.floor(seconds / 3600), "h"], [Math.floor((seconds % 3600) / 60), "m"], [seconds % 60, "s"]] as const;
  const shown = parts.filter(([value], index) => value > 0 || index === 2).map(([value, unit]) => `${value}${unit}`);
  return shown.join(" ");
}

const outbox = defineCommand({
  name: "events outbox",
  usage: "quickservicets events outbox",
  description: "Prints, per durable consumer, how many deliveries are pending, delivering, delivered and failed, and the age of the oldest pending one.",
  json: { consumers: [{ consumer: "string", pending: "number", delivering: "number", delivered: "number", failed: "number", oldestPending: "string?" }] },
  async run(ctx) {
    const adapter = await connected(ctx);
    const rows = await rowsWhere(adapter, []);
    const byConsumer = new Map<string, StoredRecord[]>();
    for (const row of rows) byConsumer.set(row.consumer as string, [...(byConsumer.get(row.consumer as string) ?? []), row]);
    if (byConsumer.size === 0) ctx.output.log("No deliveries.");
    const now = Date.now();
    const consumers: Record<string, unknown>[] = [];
    for (const [consumer, list] of [...byConsumer].sort(([a], [b]) => a.localeCompare(b))) {
      const counts = DELIVERY_STATUSES.map((status) => `${status} ${list.filter((row) => row.status === status).length}`).join(", ");
      const pending = list.filter((row) => row.status === "pending").map((row) => new Date(row.createdAt).getTime());
      const oldest = pending.length > 0 ? `; oldest pending ${age(now - Math.min(...pending))}` : "";
      ctx.output.log(`${consumer}: ${counts}${oldest}`);
      consumers.push({
        consumer,
        ...Object.fromEntries(DELIVERY_STATUSES.map((status) => [status, list.filter((row) => row.status === status).length])),
        oldestPending: pending.length > 0 ? new Date(Math.min(...pending)).toISOString() : null,
      });
    }
    ctx.result({ consumers });
  },
});

const retry = defineCommand({
  name: "events retry",
  usage: "quickservicets events retry <delivery id> | quickservicets events retry --consumer <name> --failed",
  description: "Resets failed deliveries to pending with attempt 0, one by id or every failed one of a consumer, and prints how many.",
  args: [{ name: "id", description: "The id of one failed delivery." }],
  flags: object({
    consumer: string().optional().describe("The consumer whose failed deliveries are reset."),
    failed: boolean().default(false).describe("Resets the consumer's failed deliveries."),
  }),
  async run(ctx) {
    const id = ctx.args.id;
    if (!id && !(ctx.flags.consumer && ctx.flags.failed)) {
      ctx.output.error("Name a delivery id, or --consumer <name> --failed");
      return 1;
    }
    const adapter = await connected(ctx);
    const where: Condition[] = [{ field: "status", op: "eq", value: "failed" }];
    if (id) where.push({ field: "id", op: "eq", value: id });
    if (ctx.flags.consumer) where.push({ field: "consumer", op: "eq", value: ctx.flags.consumer });
    const model = outboxDeliveryEntity();
    let count = 0;
    const now = new Date();
    for (const row of await rowsWhere(adapter, where)) {
      const updated = await adapter.updateById(model, row.id, { status: "pending", attempt: 0, nextAttemptAt: now, lockedUntil: null, updatedAt: now }, [{ field: "status", op: "eq", value: "failed" }]);
      if (updated) count++;
    }
    ctx.output.log(`Reset ${count} ${count === 1 ? "delivery" : "deliveries"} to pending`);
  },
});

/** The commands of the `events` native. */
export const eventCommands = [outbox, retry];
