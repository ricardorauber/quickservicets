import { job } from "@quickservicets/core"

/** Every night at 03:00 UTC, deactivates the active memberships of inactive organizations and returns how many. */
export default job(
    "0 3 * * *",
    async ({ repos, log }) => {
        const organizations = await repos.organizations.where((o) => o.active.eq(false)).select("id").all()
        if (organizations.length === 0) return 0
        const ids = organizations.map((organization) => organization.id)
        const memberships = await repos.memberships.where((m) => m.active.eq(true).and(m.organization.in(ids))).select("id").all()
        for (const membership of memberships) await repos.memberships.update(membership.id, { active: false })
        log.info("Memberships deactivated", { deactivated: memberships.length })
        return memberships.length
    },
    { timeZone: "UTC" },
)
