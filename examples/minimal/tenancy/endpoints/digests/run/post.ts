import type { Repositories, ServiceRequest } from "@quickservicets/core";

/**
 * Runs the digest job now, for every tenant.
 * @tenancy off
 */
export default async (_repos: Repositories, req: ServiceRequest) => req.jobs.run("digest");
