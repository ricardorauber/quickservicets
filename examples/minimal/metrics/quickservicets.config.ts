import { defineConfig, sqliteAdapter } from "@quickservicets/core";

export default defineConfig({
  database: sqliteAdapter({ path: "data.db" }),
  // Closed windows go to the MetricWindow table, so every worker and replica reports the whole service.
  metrics: { store: "database" },
  tenancy: { source: "config", tenants: { acme: {}, globex: {} } },
});
