import { requireUser, type Endpoint } from "@quickservicets/core";

/** @summary The signed-in user */
const handler: Endpoint = (_repos, req) => requireUser(req);

export default handler;
