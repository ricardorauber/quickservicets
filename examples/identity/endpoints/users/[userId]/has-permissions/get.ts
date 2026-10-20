import { type Endpoint } from "@quickservice/core";

type Query = {
    /** Permissions as `<module slug>:<action>`, e.g. `billing:manage`; repeat the key for each one. */
    p: string[]
    /** `all`: every permission is required; `any`: one is enough. */
    rule: "all" | "any"
    /** The organization the permissions apply to. */
    organization: string
}

/**
 * @summary Check a user's permissions
 * @description Grants come from the user's active membership in the organization and from its active teams the user belongs to; `manage` also grants `view`.
 */
const handler: Endpoint<Query, boolean> = async (repos, req) => {
    const { p, rule, organization } = req.queryItems
    const userId = req.params.userId!

    const org = await repos.organizations.where((o) => o.id.eq(organization).and(o.active.eq(true))).firstOrDefault()
    if (!org) return false

    const memberships = await repos.memberships
        .where((m) => m.user.eq(userId).and(m.organization.eq(organization)).and(m.active.eq(true)))
        .include("profiles.permissions.module")
        .all()
    const teams = await repos.teams
        .where((t) => t.users.contains(userId).and(t.organization.eq(organization)).and(t.active.eq(true)))
        .include("profiles.permissions.module")
        .all()

    const granted = new Set(
        [...memberships, ...teams]
            .flatMap((source) => source.profiles)
            .flatMap((profile) => profile.permissions)
            .filter(({ module }) => module?.active)
            .flatMap(({ module, action }) => action === "manage" ? [`${module!.slug}:manage`, `${module!.slug}:view`] : [`${module!.slug}:view`]),
    )
    return rule === "all" ? p.every((permission) => granted.has(permission)) : p.some((permission) => granted.has(permission))
}

export default handler
