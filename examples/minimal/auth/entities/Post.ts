/**
 * Anyone signed in reads posts; only editors write them.
 * @auth
 * @roles editor:write
 */
export type Post = {
  /** @minLength 1 */
  title: string;
};
