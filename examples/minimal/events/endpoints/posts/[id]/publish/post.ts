import { events, HttpError, type Endpoint } from "@quickservice/core";

/** Publishes a post and emits `post.published` in the same transaction: a failed publish emits nothing. */
const publish: Endpoint<{ dryRun?: boolean }> = async (repos, req) =>
  repos.transaction(async () => {
    const post = await repos.posts.update(req.params.id!, { published: true });
    await events.emit("post.published", { postId: post.id });
    if ((await req.json()).dryRun) throw new HttpError(409, "Dry run: nothing was published");
    return post;
  });

export default publish;
