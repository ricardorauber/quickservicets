// WHAT-IF: request logging disabled through the documented `logger` option.
import { defineConfig, localStorage, postgresAdapter } from "@quickservice/core";

const silent = { info() {}, warn() {}, error() {} };

export default defineConfig({
  database: postgresAdapter({ url: process.env.DATABASE_URL ?? "postgres://bench:bench@localhost:55432/bench" }),
  server: { port: Number(process.env.PORT ?? 8080) },
  storage: { default: localStorage({ dir: process.env.UPLOAD_DIR ?? "uploads" }) },
  logger: silent,
});
