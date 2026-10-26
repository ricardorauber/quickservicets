import { existsSync } from "node:fs";
import { join } from "node:path";
import { boolean, defineCommand, integer, object, string, type CommandContext } from "../public.ts";
import { brokerMethod, type QueueBroker } from "./broker.ts";
import { bindDatabaseBroker, databaseBroker, isDatabaseBroker } from "./database.ts";
import { queueMessageEntity } from "./message.ts";
import { isQueueDefinition, type QueueDefinition } from "./queue.ts";

type QueuesOptions = {
  pollInterval: string;
  retention: { completed: string; dead: string };
  broker?: QueueBroker;
};

/** The queues the last build declared, read from `.generated/features.ts`. */
async function declaredQueues(cwd: string): Promise<Map<string, QueueDefinition>> {
  const file = join(cwd, ".generated/features.ts");
  if (!existsSync(file)) return new Map();
  const { featureFolders } = (await import(file)) as { featureFolders?: Record<string, Record<string, ReadonlyMap<string, unknown>>> };
  const declared = new Map<string, QueueDefinition>();
  for (const [name, value] of featureFolders?.queues?.queues ?? []) if (isQueueDefinition(value)) declared.set(name, value);
  return declared;
}

/** Connects to the project's database and returns the configured broker, or the database broker. */
async function connected(ctx: CommandContext<unknown, unknown>): Promise<QueueBroker> {
  await ctx.connect();
  const options = ctx.options as QueuesOptions;
  const broker = options.broker ?? databaseBroker();
  if (isDatabaseBroker(broker)) {
    bindDatabaseBroker(broker, {
      adapter: ctx.config.database,
      model: queueMessageEntity(),
      pollInterval: options.pollInterval,
      production: ctx.config.production,
      resultLimit: ctx.config.jobs.limits.result,
      retention: options.retention,
      queues: [...(await declaredQueues(ctx.cwd)).keys()],
    });
  }
  return broker;
}

/** A duration in milliseconds as `1h 2m 3s`. */
export function age(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const parts = [[Math.floor(seconds / 86_400), "d"], [Math.floor((seconds % 86_400) / 3600), "h"], [Math.floor((seconds % 3600) / 60), "m"], [seconds % 60, "s"]] as const;
  return parts
    .filter(([value], index) => value > 0 || index === parts.length - 1)
    .map(([value, unit]) => `${value}${unit}`)
    .join(" ");
}

const list = defineCommand({
  name: "queue list",
  usage: "quickservicets queue list",
  description: "Prints each queue with its number of waiting, active, completed and dead messages, and the age of its oldest waiting message.",
  async run(ctx) {
    const stats = await (await connected(ctx)).stats();
    const names = Object.keys(stats);
    if (names.length === 0) ctx.output.log("No queues.");
    const now = Date.now();
    for (const name of names) {
      const { waiting, active, completed, dead, oldestWaiting } = stats[name]!;
      const oldest = oldestWaiting ? `; oldest waiting ${age(now - oldestWaiting.getTime())}` : "";
      ctx.output.log(`${name}: waiting ${waiting}, active ${active}, completed ${completed}, dead ${dead}${oldest}`);
    }
  },
});

const dead = defineCommand({
  name: "queue dead",
  usage: "quickservicets queue dead <queue> [--limit <n>]",
  description: "Prints the latest dead messages of a queue with their id, attempts, finish time and error message.",
  args: [{ name: "queue", required: true, description: "The queue name." }],
  flags: object({ limit: integer().min(1).default(20).describe("How many messages to print.") }),
  async run(ctx) {
    const queue = ctx.args.queue!;
    const messages = await brokerMethod(await connected(ctx), "dead")(queue, { limit: ctx.flags.limit });
    if (messages.length === 0) ctx.output.log(`No dead messages in ${queue}.`);
    for (const message of messages) {
      const finished = message.finishedAt ? new Date(message.finishedAt).toISOString() : "-";
      ctx.output.log(`${message.id}  attempts ${message.attempt}  ${finished}  ${message.lastError?.message ?? ""}`);
    }
  },
});

const retry = defineCommand({
  name: "queue retry",
  usage: "quickservicets queue retry <message id> | quickservicets queue retry --queue <name> --dead",
  description: "Moves dead messages back to waiting with attempt 0, one by id or every dead one of a queue, and prints how many.",
  args: [{ name: "id", description: "The id of one dead message." }],
  flags: object({
    queue: string().optional().describe("The queue whose dead messages are requeued."),
    dead: boolean().default(false).describe("Requeues the queue's dead messages."),
  }),
  async run(ctx) {
    const id = ctx.args.id;
    if (!id && !(ctx.flags.queue && ctx.flags.dead)) {
      ctx.output.error("Name a message id, or --queue <name> --dead");
      return 1;
    }
    const broker = await connected(ctx);
    let count = 1;
    if (id) await brokerMethod(broker, "retry")(id);
    else count = await brokerMethod(broker, "retryDead")(ctx.flags.queue!);
    ctx.output.log(`Requeued ${count} ${count === 1 ? "message" : "messages"}`);
  },
});

/** The commands of the `queues` native. */
export const queueCommands = [list, dead, retry];
