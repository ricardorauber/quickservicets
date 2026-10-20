import type { Media } from "@quickservice/core"
import { Membership } from "./Membership"
import { Team } from "./Team"

export enum UserRole {
    admin,
    basic
}

export type User = {
    email: string
    name?: string
    picture?: Media

    /** @default UserRole.basic */
    role: UserRole

    memberships: Membership[]
    teams: Team[]
}