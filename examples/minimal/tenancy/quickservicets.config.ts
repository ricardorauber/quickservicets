import { defineConfig, memoryAdapter } from "@quickservicets/core";

export default defineConfig({
  database: memoryAdapter(),
  // Every request names its tenant in the x-tenant-id header; the tenants come from the config.
  tenancy: { source: "config", tenants: { acme: { plan: "free" }, globex: { plan: "enterprise" } } },
});
