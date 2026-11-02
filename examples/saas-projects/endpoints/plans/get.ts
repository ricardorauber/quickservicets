import type { Repositories } from "@quickservicets/core";

/**
 * The plans and their limits, for the sign-up page: answered without a tenant.
 * @tenancy off
 */
export default (repos: Repositories) => repos.plans.list({ where: [], sort: [{ field: "slug", direction: "asc" }], limit: 100, offset: 0 });
