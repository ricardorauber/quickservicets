import type { Repositories, ServiceRequest } from "@quickservice/core";

/**
 * The flags of the caller, for the client to show or hide features.
 * @demoUser
 */
export default (_repos: Repositories, req: ServiceRequest) => req.flags!.all();
