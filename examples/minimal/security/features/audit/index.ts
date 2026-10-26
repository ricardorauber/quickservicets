import { defineFeature } from "@quickservicets/core";

/** Logs every created customer; the security native shows its `@sensitive` tax id as `[sensitive]`. */
export default defineFeature({
  key: "audit",
  setup(ctx) {
    ctx.app.use({
      stage: "handler",
      async run(req, _res, next) {
        const result = await next();
        if (req.method === "POST" && req.route === "/customers") ctx.logger.info({ timestamp: new Date().toISOString(), message: "customer.created", customer: result });
        return result;
      },
    });
  },
});
