import { listen } from "@quickservice/core";

/** Keeps `commentCount` of a post in step with its comments, after each committed comment change. */
export default listen("comment.written", async (event, { repos }) => {
  const postId = (event.after ?? event.before).post;
  if (!(await repos.posts.findById(postId))) return;
  const commentCount = await repos.comments.where((comment) => comment.post.eq(postId)).count();
  await repos.posts.update(postId, { commentCount });
});
