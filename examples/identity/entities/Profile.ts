import { Permission } from "./Permission"

export type Profile = {
    slug: string
    permissions: Permission[]
}