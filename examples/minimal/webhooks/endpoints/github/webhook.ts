import { defineWebhook, env, githubSignature } from "@quickservicets/core";

/** Records each push GitHub sends, once per delivery. */
export default defineWebhook<{ ref?: string }>({
  verify: githubSignature({ secret: env.GITHUB_WEBHOOK_SECRET }),
  handle: async (event, ctx) => {
    if (ctx.eventType !== "push") return;
    await ctx.repos.pushes.create({ delivery: ctx.deliveryId ?? "", ref: event.ref ?? "" });
  },
});
