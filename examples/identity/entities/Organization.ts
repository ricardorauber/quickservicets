import type { Media } from "@quickservice/core"
import { Membership } from "./Membership"
import { Module } from "./Module"

export type Organization = {
    slug: string
    legalName: string
    name?: string
    logo?: Media;
    active: boolean
    modules: Module[]
    members: Membership[]
}