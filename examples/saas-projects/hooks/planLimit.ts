import { definePreHook, HttpError, type Repositories } from "@quickservicets/core";

/**
 * Refuses a new project when the workspace already has as many active projects as its plan allows, reading the plan
 * through the shared Plan repository; a plan without maxProjects is unlimited.
 */
export default definePreHook(
  async (repos: Repositories, req) => {
    const slug = req.tenant?.plan;
    if (!slug) return;
    const plan = (await repos.plans.list({ where: [{ field: "slug", op: "eq", value: slug }], sort: [], limit: 1, offset: 0 })).data[0];
    if (plan?.maxProjects === undefined || plan.maxProjects === null) return;
    const active = await repos.projects.list({ where: [{ field: "archived", op: "eq", value: false }], sort: [], limit: 1, offset: 0 });
    if (active.total >= plan.maxProjects) throw new HttpError(402, `Your plan allows ${plan.maxProjects} projects`, { code: "PLAN_LIMIT_REACHED" });
  },
  { docs: { responses: [402] } },
);
