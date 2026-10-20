import { Permission } from "./Permission"

export type Profile = {
    /** @unique @minLength 2 @maxLength 64 */
    slug: string
    permissions: Permission[]
}