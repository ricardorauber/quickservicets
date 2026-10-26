import { HttpError, type Endpoint } from "@quickservicets/core";

type Stats = { members: number; admins: number; averageAge: number | null };

/**
 * @summary Organization stats
 * @description Counts the members and admins of an organization and averages their ages.
 */
const handler: Endpoint<unknown, Stats> = async (repos, req) => {
  const stats = await repos.organizations
    .related(req.params.orgId!, "members")
    .aggregate((u) => ({ members: u.count(), admins: u.count(u.role.eq("admin")), averageAge: u.age.avg() }));
  if (!stats) throw new HttpError(404, "Organization not found");
  return stats;
};

export default handler;
