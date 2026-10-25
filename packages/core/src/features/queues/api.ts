import type { QueueBroker } from "./broker.ts";

/** The feature API of `queues`, reached with `ctx.feature("queues")` from a feature that lists `queues` in `requires` or `after`. */
export interface QueuesApi {
  /**
   * Replaces the database broker with `broker`, from the calling feature's setup only; startup fails with
   * `Queue broker set by <a> and <b>; keep one` when `queues.broker` or another feature set one too.
   */
  setBroker(broker: QueueBroker): void;
}
