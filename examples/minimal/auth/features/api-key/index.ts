import { defineFeature } from "@quickservicets/core";
import { apiKeyProvider } from "../../lib/api-key.ts";

/** Registers the project's API key provider with the auth native. */
export default defineFeature({
  key: "api-key",
  enabledByDefault: true,
  requires: ["auth"],
  setup(ctx) {
    ctx.feature("auth").provider(apiKeyProvider());
  },
});
