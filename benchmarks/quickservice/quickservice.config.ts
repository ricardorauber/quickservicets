import { defineConfig, localStorage, postgresAdapter } from "@quickservice/core";

export default defineConfig({
  // run.ts passes DATABASE_URL; the fallback is the compose database published on the host.
  database: postgresAdapter({ url: process.env.DATABASE_URL ?? "postgres://bench:bench@localhost:55432/bench" }),
  server: { port: Number(process.env.PORT ?? 8080) },
  storage: {
    default: localStorage({ dir: process.env.UPLOAD_DIR ?? "uploads" }),
  },
});
