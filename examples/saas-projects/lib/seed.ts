import { runForTenant, type Repositories } from "@quickservicets/core";
import { signUp } from "./signup.ts";

/** The plans and their limits; enterprise has none. */
export const PLANS = [
  { slug: "free", maxProjects: 3, maxMembers: 5 },
  { slug: "pro", maxProjects: 50, maxMembers: 100 },
  { slug: "enterprise" },
] as const;

/** The sample workspaces: acme and globex share the service's database through schemas, initech has its own. */
export const TENANTS = [
  { id: "acme", plan: "free", projects: ["Website", "Launch"] },
  { id: "globex", plan: "pro", projects: ["Mobile app", "Data platform"] },
  { id: "initech", plan: "enterprise", projects: ["TPS reports"] },
] as const;

const page = { sort: [], limit: 1, offset: 0 };

/**
 * Creates the plans, signs the sample workspaces up (provisioning their schemas or database) and gives each one
 * projects and tasks; each step looks its records up first, so running it again creates only what is missing.
 */
export async function seedShowcase(repos: Repositories): Promise<void> {
  for (const plan of PLANS) {
    const existing = await repos.plans.list({ where: [{ field: "slug", op: "eq", value: plan.slug }], ...page });
    if (existing.total === 0) await repos.plans.create({ ...plan });
  }
  for (const tenant of TENANTS) {
    const existing = await repos.tenants.list({ where: [{ field: "key", op: "eq", value: tenant.id }], ...page });
    if (existing.total === 0) await signUp(repos, { workspace: tenant.id, plan: tenant.plan, owner: `${tenant.id}-owner`, billingEmail: `billing@${tenant.id}.example.com` });
    await runForTenant(tenant.id, async (context) => {
      const own = context.repos as unknown as Repositories;
      if ((await own.projects.list({ where: [], ...page })).total > 0) return;
      for (const name of tenant.projects) {
        const project = await own.projects.create({ name });
        await own.tasks.create({ project: project.id, title: `Plan ${name}`, status: "doing", assigneeId: `${tenant.id}-owner` });
        await own.tasks.create({ project: project.id, title: `Ship ${name}`, status: "todo" });
      }
    });
  }
}
