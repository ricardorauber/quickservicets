export enum ModuleAction {
    manage,
    view
}

export type Module = {
    /** @unique @minLength 2 @maxLength 64 */
    slug: string
    /** @default true */
    active: boolean
}