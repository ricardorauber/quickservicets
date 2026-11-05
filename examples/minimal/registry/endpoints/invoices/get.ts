import type { Endpoint } from "@quickservicets/core";

/** The invoices of the billing service, from one of its 2.x instances. */
const handler: Endpoint = (_repos, req) => req.http.service("billing").get("/invoices").send();

export default handler;
