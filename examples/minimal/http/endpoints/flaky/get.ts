import type { Repositories, ServiceRequest } from "@quickservicets/core";

/** Calls an upstream route that fails every other time; the service's retry hides the failure. */
export default (_repos: Repositories, req: ServiceRequest) => req.http.service("quotes").get("/flaky").send();
