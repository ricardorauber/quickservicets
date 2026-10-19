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
  const members = await repos.users
    .where((u) => u.id.in(organization.members))
    .select("role", "age")
    .all();
  let admins = 0;
  let ageSum = 0;
  let ageCount = 0;
  for (const member of members) {
    if (member.role === "admin") admins++;
    if (member.age !== null && member.age !== undefined) {
      ageSum += member.age;
      ageCount++;
    }
  }
  return { members: members.length, admins, averageAge: ageCount === 0 ? null : ageSum / ageCount };
};

export default handler;
