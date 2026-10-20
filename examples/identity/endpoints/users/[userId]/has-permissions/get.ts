import { type Endpoint } from "@quickservice/core";
import { grantedPermissions } from "../../../../lib/permissions";

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
    const granted = await grantedPermissions(repos, req.params.userId!, organization)
    return rule === "all" ? p.every((permission) => granted.has(permission)) : p.some((permission) => granted.has(permission))
}

export default handler
