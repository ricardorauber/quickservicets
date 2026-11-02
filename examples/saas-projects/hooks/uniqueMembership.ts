import { definePreHook, HttpError, type Repositories } from "@quickservicets/core";

/** Refuses a second membership of the same user in the same workspace: a member is unique on both ids. */
export default definePreHook(
  async (repos: Repositories, req) => {
    const body = (await req.json()) as { tenantKey?: string; userId?: string };
    if (!body?.tenantKey || !body.userId) return;
    const existing = await repos.members.list({ where: [{ field: "tenantKey", op: "eq", value: body.tenantKey }, { field: "userId", op: "eq", value: body.userId }], sort: [], limit: 1, offset: 0 });
    if (existing.total > 0) throw new HttpError(409, "Member already exists", { code: "CONFLICT" });
  },
  { docs: { responses: [409] } },
);
