import { defineConfig, memoryAdapter } from "@quickservice/core";

export default defineConfig({
  database: memoryAdapter(),
  "demo-user": {},
  flags: {
    rules: {
      "checkout-v2": { users: ["u1"], percentage: 10 },
      "dark-mode": true,
    },
  },
});
