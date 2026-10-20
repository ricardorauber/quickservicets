import type { Media } from "@quickservice/core"
import { Membership } from "./Membership"
import { Team } from "./Team"

export enum UserRole {
    admin,
    basic
}

export type User = {
    /** @unique @format email @maxLength 254 */
    email: string
    /** @minLength 1 @maxLength 120 */
    name?: string
    /** @accept image/png,image/jpeg,image/webp @maxSize 1MB */
    picture?: Media
    /** @default UserRole.basic */
    role: UserRole
    memberships: Membership[]
    teams: Team[]
}