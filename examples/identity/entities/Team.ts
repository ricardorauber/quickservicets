import { Media } from "@quickservicets/core"
import { Organization } from "./Organization"
import { Profile } from "./Profile"
import { User } from "./User"

/** @history */
export type Team = {
    organization: Organization
    /** @minLength 1 @maxLength 120 */
    name: string
    /** @accept image/png,image/jpeg,image/webp @maxSize 1MB */
    picture?: Media
    users: User[]
    profiles: Profile[]
    /** @default true */
    active: boolean
}