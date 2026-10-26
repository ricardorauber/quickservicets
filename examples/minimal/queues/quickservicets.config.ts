import { defineConfig, memoryAdapter } from "@quickservicets/core";

export default defineConfig({
  database: memoryAdapter(),
  events: {},
  queues: {
    overrides: { "send-email": { concurrency: 2 } },
    defaultPriority: ({ req }) => (req?.headers.get("x-vip") ? 10 : 0),
  },
  digest: {},
});
