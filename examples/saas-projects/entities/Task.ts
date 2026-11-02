import type { Project } from "./Project";

/** A task of a project; the assignee is a user id of the identity provider. */
export type Task = {
  project: Project;
  /** @minLength 1 */
  title: string;
  /** @default "todo" */
  status: "todo" | "doing" | "done";
  assigneeId?: string;
  dueAt?: Date;
};
