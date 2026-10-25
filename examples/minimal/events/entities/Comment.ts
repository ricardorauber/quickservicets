import type { Post } from "./Post";

export type Comment = {
  body: string;
  /** Comments go away with their post. @onDelete cascade */
  post: Post;
};
