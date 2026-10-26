import type { Repositories, ServiceRequest } from "@quickservicets/core";

/** The flags of the caller, for the client to show or hide features. */
export default (_repos: Repositories, req: ServiceRequest) => req.flags!.all();
