import { HttpError, type Endpoint } from "@quickservice/core"

type Stats = {
    members: number
    activeMembers: number
    teams: number
    activeTeams: number
    /** The distinct profiles the organization's memberships and teams carry. */
    profiles: number
}

/**
 * @summary Organization stats
 * @description Counts the organization's memberships and teams, all and active ones, and the distinct profiles they carry. The caller (the `x-user-id` header, a stand-in for real authentication) needs `organizations:view` in the organization.
 * @requires organizations:view
 */
const handler: Endpoint<unknown, Stats> = async (repos, req) => {
    const orgId = req.params.orgId!
    if (!(await repos.organizations.where((o) => o.id.eq(orgId)).any())) throw new HttpError(404, "Organization not found")

    const memberships = repos.memberships.where((m) => m.organization.eq(orgId))
    const teams = repos.teams.where((t) => t.organization.eq(orgId))
    const [members, teamCounts, profileIds] = await Promise.all([
        memberships.aggregate((m) => ({ members: m.count(), activeMembers: m.count(m.active.eq(true)) })),
        teams.aggregate((t) => ({ teams: t.count(), activeTeams: t.count(t.active.eq(true)) })),
        Promise.all([memberships.select("profiles").all(), teams.select("profiles").all()]).then((sources) => [
            ...new Set(sources.flat().flatMap((source) => source.profiles)),
        ]),
    ])
    const { profiles } = profileIds.length === 0
        ? { profiles: 0 }
        : await repos.profiles.where((p) => p.id.in(profileIds)).aggregate((p) => ({ profiles: p.count() }))
    return { ...members, ...teamCounts, profiles }
}

export default handler
