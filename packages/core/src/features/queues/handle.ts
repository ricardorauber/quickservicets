import { operationContextEnabled, safeLog, systemClock, withOperation, type JobClock, type JobLogFields, type JobLogger, type Logger, type Repositories } from "../public.ts";
import type { QueueBrokerContext } from "./broker.ts";
import { queueClient } from "./client.ts";
import type { QueueContext, QueueDefinition } from "./queue.ts";

export interface ConsumerHandlerOptions {
  /** The declared queues by name. */
  definitions: ReadonlyMap<string, QueueDefinition>;
  /** The repositories the consumers receive, known once the service started. */
  repos: () => Repositories;
  logger: Logger;
  clock?: JobClock;
}

/** The `handle` of a broker's start context: runs a message's consumer with its context, inside its operation. */
export function consumerHandler(options: ConsumerHandlerOptions): QueueBrokerContext["handle"] {
  const clock = options.clock ?? systemClock;
  return async (message, { signal }) => {
    const write = (level: "info" | "warn" | "error") => (line: string, fields?: JobLogFields) =>
      safeLog(options.logger, level, { timestamp: new Date(clock.now()).toISOString(), message: String(line), ...fields, queue: message.queue, messageId: message.id });
    const log: JobLogger = { info: write("info"), warn: write("warn"), error: write("error") };
    try {
      const definition = options.definitions.get(message.queue);
      if (!definition) throw new Error(`No consumer is declared for the queue ${message.queue}`);
      const context: QueueContext = {
        payload: message.payload,
        repos: options.repos(),
        message: { id: message.id, queue: message.queue, attempt: message.attempt, enqueuedAt: new Date(message.enqueuedAt), ...(message.dedupeKey ? { dedupeKey: message.dedupeKey } : {}) },
        signal,
        log,
        queue: queueClient(),
      };
      const run = () => definition.handler(context);
      const result = await (operationContextEnabled() ? withOperation({ queue: { name: message.queue, messageId: message.id } }, run) : run());
      return { completed: true, result };
    } catch (error) {
      return { failed: error };
    }
  };
}
