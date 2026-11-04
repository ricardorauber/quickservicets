import type { ServiceRequest } from "@quickservicets/core";

/** Queues the notification of a post; the `notify` queue consumes it in the background. */
export default async (_repos: unknown, req: ServiceRequest) => req.queue.add("notify", { postId: req.params.id! });
