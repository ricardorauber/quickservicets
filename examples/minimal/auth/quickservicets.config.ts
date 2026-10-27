import { defineConfig, memoryAdapter, secret } from "@quickservicets/core";

export default defineConfig({
  database: memoryAdapter(),
  env: { API_KEY: secret().optional() },
  auth: {},
});
