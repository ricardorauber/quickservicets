import { defineConfig, memoryAdapter } from "@quickservicets/core";

export default defineConfig({
  database: memoryAdapter(),
  health: {},
  registry: {
    name: "invoices",
    // Two billing instances without a registry server: run them with `bun run upstreams`.
    services: {
      billing: {
        instances: [
          { url: "http://localhost:4101", version: "1.4.0" },
          { url: "http://localhost:4102", version: "2.1.0" },
        ],
      },
    },
  },
  http: { services: { billing: { discover: "billing@^2", retry: true } } },
});
