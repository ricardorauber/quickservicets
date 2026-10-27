import type { Repositories, ServiceRequest } from "@quickservicets/core";

/** The tenant the request was resolved to. */
export default (_repos: Repositories, req: ServiceRequest) => ({ tenant: req.tenant?.id });
