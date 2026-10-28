import { contextFlags, contextHttp, operationContextEnabled, parseTraceparent, spanAttributes, startSpan, tracingEnabled, withSpan, runForTenant, safeLog, systemClock, withOperation, type JobClock, type JobLogFields, type JobLogger, type Logger, type Repositories } from "../public.ts";
import type { QueueBrokerContext, QueueReceivedMessage } from "./broker.ts";
import { queueClient } from "./client.ts";
import type { QueueContext, QueueDefinition } from "./queue.ts";

export interface ConsumerHandlerOptions {
  /** The declared queues by name. */
  definitions: ReadonlyMap<string, QueueDefinition>;
  /** The repositories the consumers receive, known once the service started. */
  repos: () => Repositories;
  /** Chooses the repositories of each message's run instead of `repos`; the native passes the service's run resolution. */
  runRepositories?: (run: { queue: { name: string; messageId: string } }) => Repositories;
  logger: Logger;
  clock?: JobClock;
  /** Changes the payload before the consumer runs; a throw fails the attempt. */
  beforeProcess?: (message: QueueReceivedMessage, payload: unknown) => unknown | Promise<unknown>;
}

/** `ctx.http` of a consumer, sending the message's id, while the `http` native runs. */
function httpOf(messageId: string): { http?: QueueContext["http"] } {
  const client = contextHttp(messageId);
  return client ? { http: client } : {};
}

/** The `handle` of a broker's start context: runs a message's consumer with its context, inside its operation. */
export function consumerHandler(options: ConsumerHandlerOptions): QueueBrokerContext["handle"] {
  const clock = options.clock ?? systemClock;
  const handle: QueueBrokerContext["handle"] = async (message, { signal }) => {
    const write = (level: "info" | "warn" | "error") => (line: string, fields?: JobLogFields) =>
      safeLog(options.logger, level, { timestamp: new Date(clock.now()).toISOString(), message: String(line), ...fields, queue: message.queue, messageId: message.id });
    const log: JobLogger = { info: write("info"), warn: write("warn"), error: write("error") };
    try {
      const definition = options.definitions.get(message.queue);
      if (!definition) throw new Error(`No consumer is declared for the queue ${message.queue}`);
      const payload = options.beforeProcess ? await options.beforeProcess(message, message.payload) : message.payload;
      const context = {
        payload,
        repos: options.runRepositories ? options.runRepositories({ queue: { name: message.queue, messageId: message.id } }) : options.repos(),
        message: { id: message.id, queue: message.queue, attempt: message.attempt, enqueuedAt: new Date(message.enqueuedAt), ...(message.dedupeKey ? { dedupeKey: message.dedupeKey } : {}) },
        signal,
        log,
        queue: queueClient(),
        // `ctx.flags` exists while the `flags` native runs; its type comes from the generated flag types.
        ...(contextFlags() ? { flags: contextFlags() } : {}),
        ...httpOf(message.id),
      } as QueueContext;
      // A message added for a tenant runs in that tenant's scope; an unknown or suspended tenant fails the attempt.
      const run = () => (message.tenant !== undefined ? runForTenant(message.tenant, ({ tenant, repos }) => definition.handler({ ...context, tenant, repos: repos as never })) : definition.handler(context));
      const operation = { queue: { name: message.queue, messageId: message.id }, ...(message.requestId ? { requestId: message.requestId } : {}) };
      const result = await (operationContextEnabled() ? withOperation(operation, run) : run());
      return { completed: true, result };
    } catch (error) {
      return { failed: error };
    }
  };
  // With a tracer, each run starts a new trace in a `consumer` span linked to the span that added the message.
  return async (message, context) => {
    if (!tracingEnabled()) return handle(message, context);
    const link = parseTraceparent(message.trace);
    const span = startSpan(`process ${message.queue}`, {
      kind: "consumer",
      parent: null,
      ...(link ? { links: [{ context: link }] } : {}),
      attributes: spanAttributes({
        "messaging.system": "quickservicets",
        "messaging.destination.name": message.queue,
        "messaging.message.id": message.id,
        "quickservicets.queue.attempt": message.attempt,
      }),
    });
    try {
      const outcome = await withSpan(span, () => handle(message, context));
      if ("failed" in outcome) {
        span.recordException(outcome.failed);
        span.setStatus("error");
      }
      return outcome;
    } finally {
      span.end();
    }
  };
}
