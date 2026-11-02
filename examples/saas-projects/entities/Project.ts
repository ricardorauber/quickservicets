/**
 * A project of one workspace; a workspace's plan limits how many are active.
 * @planLimit:create
 */
export type Project = {
  /** @minLength 1 */
  name: string;
  /** @default false */
  archived: boolean;
};
