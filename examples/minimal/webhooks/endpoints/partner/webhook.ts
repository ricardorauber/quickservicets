import { defineWebhook, env, standardWebhookSignature } from "@quickservicets/core";

/** Receives a partner's Standard Webhooks deliveries. */
export default defineWebhook<{ type: string }>({
  verify: standardWebhookSignature({ secret: env.PARTNER_WEBHOOK_SECRET }),
  handle: async (event, ctx) => {
    ctx.log.info("partner.event", { type: event.type });
  },
});
