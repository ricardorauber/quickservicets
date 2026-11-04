export type Post = {
  /** @minLength 1 */
  title: string;
  body?: string;
  /** @default false */
  notified: boolean;
};
