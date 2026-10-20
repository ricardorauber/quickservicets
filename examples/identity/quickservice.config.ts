import { defineConfig, postgresAdapter } from "@quickservice/core";

export default defineConfig({
  database: postgresAdapter({ url: process.env.DATABASE_URL! }),
  // "profiles.permissions.module" has three segments.
  populate: { maxDepth: 3 },
});
