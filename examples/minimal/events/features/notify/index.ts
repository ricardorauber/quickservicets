import { defineFeature, type Repositories } from "@quickservicets/core";

/**
 * Notifies about published posts: its listener file `events/notify.ts` writes an in-app notification after the
 * commit, and, with the outbox on, the durable consumer `notify/email` sends an email at least once.
 */
export default defineFeature({
  key: "notify",
  requires: ["events"],
  setup(ctx) {
    let repos: Repositories | undefined;
    ctx.app.onStart((start) => {
      repos = start.repos;
    });
    const outbox = ctx.config.features.find((feature) => feature.key === "events")?.options.outbox as { enabled?: boolean } | undefined;
    if (!outbox?.enabled) return;
    ctx.events.deliver("notify/email", {
      pattern: "post.published",
      // Deliveries repeat after a crash, so the handler skips a post it already notified.
      handler: async (event) => {
        const { postId } = (event as { payload: { postId: string } }).payload;
        if (await repos!.notifications.where((sent) => sent.postId.eq(postId).and(sent.channel.eq("email"))).count()) return;
        await repos!.notifications.create({ channel: "email", postId });
      },
    });
  },
});
