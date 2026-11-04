import { defineConfig, postgresAdapter, s3Storage } from "@quickservicets/core";

export default defineConfig({
  // `quickservicets dev --services` starts this PostgreSQL and writes DATABASE_URL to .env.
  database: postgresAdapter({ url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/app" }),
  // No endpoint, so MinIO serves the bucket locally; S3_ENDPOINT and its keys come from the local services.
  storage: { default: s3Storage({ bucket: "uploads" }) },
  queues: {},
});
