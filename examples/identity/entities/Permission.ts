import { Module, ModuleAction } from "./Module"

export type Permission = {
    module: Module
    action: ModuleAction
}