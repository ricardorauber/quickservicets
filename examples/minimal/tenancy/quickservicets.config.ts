import { defineConfig, sqliteAdapter } from "@quickservicets/core";

export default defineConfig({
  database: sqliteAdapter({ path: "data.db" }),
  // Tenants on the enterprise plan get a database of their own; the others a schema of data.db.
  tenancy: {
    strategy: ({ tenant }) => (tenant?.plan === "enterprise" ? "database" : "schema"),
    connection: "data/tenant_{tenant}.db",
  },
  queues: {},
});
