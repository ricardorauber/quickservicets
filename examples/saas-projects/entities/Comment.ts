import type { Task } from "./Task";

/** A comment on a task, by a user id of the identity provider (or system). */
export type Comment = {
  task: Task;
  authorId: string;
  /** @minLength 1 */
  body: string;
};
