import { job } from "@quickservicets/core";

/** Counts the posts every day at 06:00 UTC: a Lambda schedule, an Azure timer function, or the server's scheduler. */
export default job("0 6 * * *", async ({ repos, log }) => {
  const posts = await repos.posts.count();
  log.info("daily report", { posts });
  return { posts };
});
