export enum ModuleAction {
    manage,
    view
}

export type Module = {
    slug: string
    active: boolean
}