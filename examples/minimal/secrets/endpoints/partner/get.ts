import type { Endpoint } from "@quickservicets/core";

/** Asks the partner service for its status, authenticated with the current partner token. */
const handler: Endpoint = async (_repos, req) => req.http.service("partner" as never).get("/status").send();
export default handler;
