import type { Repositories, ServiceRequest } from "@quickservicets/core";

/** Queues a notification about a project; the consumer runs for the request's tenant. */
export default async (_repos: Repositories, req: ServiceRequest) => req.queue.add("notify", { projectId: req.params.id! });
