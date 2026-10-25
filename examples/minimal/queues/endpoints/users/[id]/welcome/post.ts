import type { ServiceRequest } from "@quickservice/core";

/** Queues the welcome email of a user once: repeated requests return the same message. */
export default async (_repos: unknown, req: ServiceRequest) =>
  req.queue.add("send-email", { userId: req.params.id! }, { dedupeKey: `welcome:${req.params.id}` });
