import { Profile } from "./Profile"
import { Organization } from "./Organization"
import { User } from "./User"

/** @history */
export type Membership = {
    organization: Organization
    user: User
    profiles: Profile[]
    /** @default true */
    active: boolean
}