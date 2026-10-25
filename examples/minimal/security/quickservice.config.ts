import { defineConfig, memoryAdapter } from "@quickservice/core";

// The security native is on by default: no key is needed.
export default defineConfig({
  database: memoryAdapter(),
  probes: {},
});
