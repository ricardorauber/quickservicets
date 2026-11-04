import { queue } from "@quickservicets/core";

/** Marks a post as notified, standing for the e-mail a real project would send. */
export default queue<{ postId: string }>(async ({ payload, repos }) => {
  await repos.posts.update(payload.postId, { notified: true });
  return { postId: payload.postId };
});
