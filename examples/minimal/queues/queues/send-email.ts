import { queue } from "@quickservice/core";

/** Sends the welcome email of a user. */
export default queue<{ userId: string }>(async ({ payload, repos }) => {
  const user = await repos.users.findById(payload.userId);
  return { sentTo: user?.email };
});
