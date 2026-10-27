import type { Endpoint } from "@quickservicets/core";

/** @summary The signed-in user, or null for an anonymous request */
const handler: Endpoint = (_repos, req) => ({ user: req.user ?? null, method: req.auth?.method ?? null });

export default handler;
