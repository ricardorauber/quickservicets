import { Profile } from "./Profile"
import { Organization } from "./Organization"
import { User } from "./User"

export type Membership = {
    organization: Organization
    user: User
    profiles: Profile[]
    active: boolean
}