import type { ServiceRequest } from "@quickservice/core";

/** Queues the welcome email of a user. */
export default async (_repos: unknown, req: ServiceRequest) => req.queue.add("send-email", { userId: req.params.id! });
