import type { Endpoint } from "@quickservice/core";

/** @summary Health check */
const handler: Endpoint<unknown, { ok: boolean }> = () => ({ ok: true });

export default handler;
