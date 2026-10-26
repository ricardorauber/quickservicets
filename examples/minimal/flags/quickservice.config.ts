import { defineConfig, memoryAdapter } from "@quickservice/core";

export default defineConfig({
  database: memoryAdapter(),
  flags: {
    rules: {
      "checkout-v2": { users: ["u1"], percentage: 10 },
      "dark-mode": true,
    },
  },
});
