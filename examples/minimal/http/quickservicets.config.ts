import { defineConfig, memoryAdapter } from "@quickservicets/core";

export default defineConfig({
  database: memoryAdapter(),
  // The client is on by default; the key only sets its options.
  http: { timeout: "5s" },
});
