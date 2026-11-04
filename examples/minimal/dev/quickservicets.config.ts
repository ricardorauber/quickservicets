import { defineConfig, postgresAdapter } from "@quickservicets/core";

export default defineConfig({
  // `quickservicets dev --services` starts this PostgreSQL and writes DATABASE_URL to .env.
  database: postgresAdapter({ url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/app" }),
});
