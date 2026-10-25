import { afterCommit, type QueueBroker, type QueueBrokerContext, type QueueBrokerMessage } from "@quickservice/core";

/** A small broker that keeps messages in memory and runs each once: enough to show how a broker plugs in. */
export function memoryBroker(): QueueBroker & { received: QueueBrokerMessage[] } {
  const received: QueueBrokerMessage[] = [];
  let ctx: QueueBrokerContext | undefined;
  const run = (id: string, message: QueueBrokerMessage) =>
    void ctx?.handle({ id, queue: message.queue, payload: message.payload, attempt: 1, enqueuedAt: new Date() }, { signal: new AbortController().signal });
  return {
    name: "memory",
    received,
    async enqueue(message, { transactional }) {
      const id = crypto.randomUUID();
      const publish = () => {
        received.push(message);
        run(id, message);
      };
      // It cannot join the database transaction, so it publishes once the transaction commits.
      if (transactional) await afterCommit(publish);
      else publish();
      return { id, deduplicated: false };
    },
    start(context) {
      ctx = context;
    },
    async stop() {
      ctx = undefined;
    },
    async stats() {
      return {};
    },
  };
}
