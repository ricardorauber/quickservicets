import { defineConfig, memoryAdapter } from "@quickservicets/core";

export default defineConfig({
  database: memoryAdapter(),
  idempotency: {
    // Batch clients may retry for a week; the others for a day.
    ttl: ({ req }) => (req?.headers.get("x-client") === "batch" ? "7d" : "24h"),
  },
});
