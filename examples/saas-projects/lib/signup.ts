import { HttpError, provisionTenant, TENANT_ID, type Repositories } from "@quickservicets/core";

/** What a sign-up creates: the workspace's tenant, provisioned, and its first member, the owner. */
export interface Signup {
  workspace: string;
  plan: string;
  owner: string;
  billingEmail?: string;
}

/**
 * Provisions a workspace: checks its id and plan, provisions the tenant (its schema or database is migrated before it
 * becomes active) and makes the user its owner. An existing workspace answers 409 `Workspace already exists`.
 */
export async function signUp(repos: Repositories, signup: Signup): Promise<{ id: string }> {
  if (typeof signup.workspace !== "string" || !TENANT_ID.test(signup.workspace)) throw new HttpError(400, "Invalid workspace: use lowercase letters, digits and dashes", { code: "VALIDATION_ERROR" });
  const plan = (await repos.plans.list({ where: [{ field: "slug", op: "eq", value: signup.plan }], sort: [], limit: 1, offset: 0 })).data[0];
  if (!plan) throw new HttpError(400, `Unknown plan ${String(signup.plan)}`, { code: "VALIDATION_ERROR" });
  try {
    await provisionTenant({ id: signup.workspace, plan: plan.slug });
  } catch (error) {
    if ((error as Error).message === `Tenant ${signup.workspace} already exists`) throw new HttpError(409, "Workspace already exists", { code: "CONFLICT" });
    throw error;
  }
  const tenant = (await repos.tenants.list({ where: [{ field: "key", op: "eq", value: signup.workspace }], sort: [], limit: 1, offset: 0 })).data[0];
  if (tenant) await repos.tenants.update(tenant.id, { planSlug: plan.slug, ...(signup.billingEmail ? { billingEmail: signup.billingEmail } : {}) });
  await repos.members.create({ tenantKey: signup.workspace, userId: signup.owner, role: "owner" });
  return { id: signup.workspace };
}
