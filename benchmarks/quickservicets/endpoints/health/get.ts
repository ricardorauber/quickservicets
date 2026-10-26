import type { Endpoint } from "@quickservicets/core";

/** @summary Health check */
const handler: Endpoint<unknown, { ok: boolean }> = () => ({ ok: true });

export default handler;
