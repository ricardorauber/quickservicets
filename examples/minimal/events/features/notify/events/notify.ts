import { listen } from "@quickservicets/core";

/** Writes an in-app notification once a post is published. */
export default listen("post.published", async (event, { repos }) => {
  await repos.notifications.create({ channel: "in-app", postId: event.payload.postId });
});
