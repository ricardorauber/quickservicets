import { defineConfig, memoryAdapter } from "@quickservicets/core";

export default defineConfig({
  database: memoryAdapter(),
  health: {},
  // The instance announces itself once it is ready, and leaves before it stops serving.
  registry: { name: "invoices", metadata: { team: "billing" } },
});
