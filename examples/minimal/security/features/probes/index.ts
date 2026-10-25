import { defineFeature } from "@quickservice/core";

/** A liveness route for the load balancer, which the security items never refuse. */
export default defineFeature({
  key: "probes",
  after: ["security"],
  setup(ctx) {
    ctx.feature("security").exempt("/health/*", ["rateLimit", "loadShedding", "ip"]);
    ctx.app.route("GET", "/health/live", () => ({ status: "ok" }));
  },
});
