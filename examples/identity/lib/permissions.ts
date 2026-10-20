import type { Repositories } from "@quickservice/core"

/**
 * The permissions, as `<module slug>:<action>`, that a user holds in an organization. They come from the profiles of
 * the user's active membership in the organization and of its active teams the user belongs to; `manage` also grants
 * `view`, and inactive modules or an inactive organization grant nothing.
 */
export async function grantedPermissions(repos: Repositories, userId: string, organizationId: string): Promise<Set<string>> {
    const org = await repos.organizations.where((o) => o.id.eq(organizationId).and(o.active.eq(true))).firstOrDefault()
    if (!org) return new Set()

    const memberships = await repos.memberships
        .where((m) => m.user.eq(userId).and(m.organization.eq(organizationId)).and(m.active.eq(true)))
        .include("profiles.permissions.module")
        .all()
    const teams = await repos.teams
        .where((t) => t.users.contains(userId).and(t.organization.eq(organizationId)).and(t.active.eq(true)))
        .include("profiles.permissions.module")
        .all()

    return new Set(
        [...memberships, ...teams]
            .flatMap((source) => source.profiles)
            .flatMap((profile) => profile.permissions)
            .filter(({ module }) => module?.active)
            .flatMap(({ module, action }) => action === "manage" ? [`${module!.slug}:manage`, `${module!.slug}:view`] : [`${module!.slug}:view`]),
    )
}
