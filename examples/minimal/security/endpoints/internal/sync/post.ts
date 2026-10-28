import type { Endpoint } from "@quickservicets/core";

/**
 * Takes a sync from the billing service. With `security.mtls` on, only a client certificate for `CN=billing` may call,
 * even when the other routes accept calls without a certificate.
 * @mtls allow=CN=billing
 */
const sync: Endpoint<unknown, { synced: boolean; by: string | null }> = (_repos, req) => ({ synced: true, by: req.client?.subject.commonName ?? null });

export default sync;
