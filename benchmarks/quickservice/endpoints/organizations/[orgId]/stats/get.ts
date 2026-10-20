import { HttpError, type Endpoint } from "@quickservice/core";

type Stats = { members: number; admins: number; averageAge: number | null };

/**
 * @summary Organization stats
 * @description Counts the members and admins of an organization and averages their ages.
 */
const handler: Endpoint<unknown, Stats> = async (repos, req) => {
  const organization = await repos.organizations.findById(req.params.orgId!);
  if (!organization) throw new HttpError(404, "Organization not found");
  if (organization.members.length === 0) return { members: 0, admins: 0, averageAge: null };
  return repos.users
    .where((u) => u.id.in(organization.members))
    .aggregate((u) => ({ members: u.count(), admins: u.count(u.role.eq("admin")), averageAge: u.age.avg() }));
};

export default handler;
