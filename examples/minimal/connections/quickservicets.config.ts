import { defineConfig, postgresAdapter } from "@quickservicets/core";

export default defineConfig({
  database: postgresAdapter({ url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/app" }),
  // The database grants this service 100 connections, shared by up to 10 instances at once.
  connections: { budget: 100, instances: 10 },
});
