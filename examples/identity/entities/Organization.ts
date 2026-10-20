import type { Media } from "@quickservice/core"
import { Membership } from "./Membership"
import { Module } from "./Module"

export type Organization = {
    /** @unique @minLength 2 @maxLength 64 */
    slug: string
    /** @minLength 1 @maxLength 200 */
    legalName: string
    /** @minLength 1 @maxLength 120 */
    name?: string
    /** @accept image/png,image/jpeg,image/webp @maxSize 1MB */
    logo?: Media;
    /** @default true */
    active: boolean
    modules: Module[]
    members: Membership[]
}