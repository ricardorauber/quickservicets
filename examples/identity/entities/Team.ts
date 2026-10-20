import { Media } from "@quickservice/core"
import { Organization } from "./Organization"
import { Profile } from "./Profile"
import { User } from "./User"

export type Team = {
    organization: Organization
    name: string
    picture?: Media
    users: User[]
    profiles: Profile[]
    active: boolean
}