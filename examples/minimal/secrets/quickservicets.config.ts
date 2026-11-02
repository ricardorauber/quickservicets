import { defineConfig, memoryAdapter, secret } from "@quickservicets/core";

export default defineConfig({
  database: memoryAdapter(),
  secrets: {},
  // API_KEY holds a reference, like file:///run/secrets/api-key, resolved when the service starts.
  env: { API_KEY: secret().optional() },
});
