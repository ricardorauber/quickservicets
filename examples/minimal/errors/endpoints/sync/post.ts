import type { Repositories, ServiceRequest } from "@quickservicets/core";

/** Starts the invoice sync now, without waiting for it. */
export default async (_repos: Repositories, req: ServiceRequest) => req.jobs.run("sync-invoices");
