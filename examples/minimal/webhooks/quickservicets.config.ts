import { defineConfig, memoryAdapter } from "@quickservicets/core";

export default defineConfig({
  database: memoryAdapter(),
  webhooks: { events: ["invoice.paid"] },
});
