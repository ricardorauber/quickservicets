import { defineFeature } from "@quickservice/core";

/** A small project feature that ships the queue `digest/notify`. */
export default defineFeature({
  key: "digest",
  docs: { summary: "Ships the digest/notify queue." },
});
