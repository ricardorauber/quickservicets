import { HttpError, type Endpoint } from "@quickservicets/core";
import projectConfig from "../../../../quickservicets.config.ts";

type Stats = { members: number; admins: number; averageAge: number | null };

// Round-2 what-if variants of the stats endpoint, picked by QS_WHATIF (the default is the shipped endpoint).
const switches = new Set((process.env.QS_WHATIF ?? "").split(","));
const client = () => (projectConfig.database as unknown as { client: Bun.SQL }).client;

/** stats1: existence and aggregate in one statement, as the plain-Bun stack does it. */
const ONE = `select count(u.id)::int as "members", (count(*) filter (where u.role = 'admin'))::int as "admins", avg(u.age)::float8 as "averageAge"
  from organizations o left join organizations__members m on m.owner_id = o.id left join users u on u.id = m.target_id
  where o.id = $1 group by o.id`;
/** stats2: an existence check and the aggregate over the junction, sent at the same time. */
const EXISTS = `select 1 from organizations where id = $1`;
const AGG = `select count(*)::int as "members", (count(*) filter (where u.role = 'admin'))::int as "admins", avg(u.age)::float8 as "averageAge"
  from organizations__members m join users u on u.id = m.target_id where m.owner_id = $1`;

/**
 * @summary Organization stats
 * @description Counts the members and admins of an organization and averages their ages.
 */
const handler: Endpoint<unknown, Stats> = async (repos, req) => {
  const orgId = req.params.orgId!;
  if (switches.has("stats1")) {
    const [row] = await client().unsafe(ONE, [orgId]);
    if (!row) throw new HttpError(404, "Organization not found");
    return row as Stats;
  }
  if (switches.has("stats2")) {
    const [exists, [row]] = await Promise.all([client().unsafe(EXISTS, [orgId]), client().unsafe(AGG, [orgId])]);
    if (exists.length === 0) throw new HttpError(404, "Organization not found");
    return row as Stats;
  }
  const organization = await repos.organizations.findById(orgId);
  if (!organization) throw new HttpError(404, "Organization not found");
  if (organization.members.length === 0) return { members: 0, admins: 0, averageAge: null };
  return repos.users
    .where((u) => u.id.in(organization.members))
    .aggregate((u) => ({ members: u.count(), admins: u.count(u.role.eq("admin")), averageAge: u.age.avg() }));
};

export default handler;
