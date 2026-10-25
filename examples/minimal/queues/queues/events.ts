import { queue, type QueuePayloads } from "@quickservice/core";

/** Logs each write event that `@publish` sends to the `events` queue. */
export default queue<QueuePayloads["events"]>(({ payload, log }) => {
  log.info("user event", { type: payload.type, recordId: payload.recordId });
  return { type: payload.type };
});
