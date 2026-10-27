import { defineConfig, memoryAdapter } from "@quickservicets/core";

export default defineConfig({
  database: memoryAdapter(),
  // Every request names its tenant in the x-tenant-id header.
  tenancy: {},
});
