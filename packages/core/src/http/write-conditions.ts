import type { ServiceRequest } from "../hooks.ts";
import type { EntityModel } from "../model.ts";
import type { WriteOptions } from "../repository.ts";

/** Decides the condition of a generated write route's request: an `If-Match` to check, none, or a thrown refusal. */
export type WriteCondition = (req: ServiceRequest, entity: EntityModel) => Pick<WriteOptions, "ifMatch" | "tagOf"> | undefined | Promise<Pick<WriteOptions, "ifMatch" | "tagOf"> | undefined>;

let condition: WriteCondition | undefined;

/** Makes the generated `PATCH`, `PUT` and `DELETE` routes ask `fn` for their condition (the `etag` native sets it); undefined removes it. */
export function setWriteCondition(fn: WriteCondition | undefined): void {
  condition = fn;
}

/** The condition of a generated write request; none while no feature set one. */
export async function writeConditionOf(req: ServiceRequest, entity: EntityModel): Promise<Pick<WriteOptions, "ifMatch" | "tagOf"> | undefined> {
  return condition ? condition(req, entity) : undefined;
}
