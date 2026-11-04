import { defineConfig, sqliteAdapter } from "@quickservicets/core";

export default defineConfig({
  database: sqliteAdapter({ path: process.env.DATABASE_PATH ?? "data.db" }),
  health: {},
  // sse.ts routes need realtime; on lambda they also need deploy.lambda.streaming.
  realtime: {},
  deploy: {
    cloudRun: { concurrency: 40, minInstances: 1 },
  },
});
