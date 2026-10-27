import type { Media } from "@quickservicets/core"
import { Membership } from "./Membership"
import { Module } from "./Module"

/** @idempotent */
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
    /**
     * The subscription plan; organizations on pro get detailed stats.
     * @default "free"
     */
    plan: "free" | "pro"
    modules: Module[]
    members: Membership[]
}