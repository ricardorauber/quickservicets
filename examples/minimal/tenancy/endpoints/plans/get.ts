import type { Repositories } from "@quickservicets/core";

/**
 * The plans, for the sign-up page: answered without a tenant.
 * @tenancy off
 */
export default (repos: Repositories) => repos.plans.list({ where: [], sort: [{ field: "price", direction: "asc" }], limit: 100, offset: 0 });
