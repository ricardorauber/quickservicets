import { defineConfig, memoryAdapter } from "@quickservicets/core";

export default defineConfig({
  database: memoryAdapter(),
  health: {
    checks: { cache: async () => ({ entries: 3 }) },
  },
  mail: {},
});
