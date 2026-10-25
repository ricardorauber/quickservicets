export type Post = {
  title: string;
  /** @default false */
  published: boolean;
  /** Kept by events/count-comments.ts. @default 0 */
  commentCount: number;
};
