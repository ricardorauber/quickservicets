import { definePreHook, HttpError } from "@quickservice/core"
import { grantedPermissions } from "../lib/permissions"

/**
 * `@requires <module>:<action>` on an endpoint with an `orgId` path parameter lets a request through only when the
 * caller holds the permission in that organization, by the same rules as `GET /users/:userId/has-permissions`.
 * Several permissions (`@requires billing:manage,reports:view`) must all be held. For an organization that does not
 * exist the request goes on, so the endpoint answers its own 404.
 *
 * Demo only: the caller is whoever the `x-user-id` header names. The header stands in for real authentication; a real
 * service would identify the caller from a verified token or session instead.
 */
export default definePreHook(
    async (repos, req, _res, args) => {
        const userId = req.headers.get("x-user-id")
        if (!userId) throw new HttpError(401, "Missing x-user-id header")
        const orgId = req.params.orgId!
        if (!(await repos.organizations.where((o) => o.id.eq(orgId)).any())) return

        const granted = await grantedPermissions(repos, userId, orgId)
        const missing = args.find((permission) => !granted.has(permission))
        if (missing) throw new HttpError(403, `Missing permission ${missing}`)
    },
    { docs: { responses: [401, 403] } },
)
