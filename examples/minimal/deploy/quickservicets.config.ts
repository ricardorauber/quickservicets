import { defineConfig, sqliteAdapter } from "@quickservicets/core";

export default defineConfig({
  database: sqliteAdapter({ path: process.env.DATABASE_PATH ?? "data.db" }),
});
