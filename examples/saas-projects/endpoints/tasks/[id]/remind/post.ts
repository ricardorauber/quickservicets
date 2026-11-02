import type { Repositories, ServiceRequest } from "@quickservicets/core";

/** Queues a reminder about a task; the consumer runs in the background for the request's workspace. */
export default async (_repos: Repositories, req: ServiceRequest) => req.queue.add("remind", { taskId: req.params.id! });
