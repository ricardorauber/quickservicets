import { Permission } from "./Permission"

/** @history */
export type Profile = {
    /** @unique @minLength 2 @maxLength 64 */
    slug: string
    permissions: Permission[]
}