import type { Endpoint } from "@quickservicets/core";

/** Asks the payments service for its balance, authenticated with the API key. */
const handler: Endpoint = async (_repos, req) => req.http.service("payments" as never).get("/balance").send();
export default handler;
