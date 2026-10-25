/**
 * A notification the notify feature sent about a post. Its writes emit no events.
 * @events off
 */
export type Notification = {
  channel: string;
  postId: string;
};
