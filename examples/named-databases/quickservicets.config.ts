import { defineConfig, sqliteAdapter } from "@quickservicets/core";

export default defineConfig({
  // The default database: customers.
  database: sqliteAdapter({ path: process.env.DATABASE_PATH ?? "data.db" }),
  databases: {
    // Everything in entities/orders/ lives in the orders database.
    orders: sqliteAdapter({ path: process.env.ORDERS_DATABASE_PATH ?? "orders.db" }),
    // On PostgreSQL instead (or keep SQLite here and set QS_DATABASES_ORDERS_URL when deploying):
    // orders: postgresAdapter({ url: process.env.ORDERS_DATABASE_URL! }),
  },
});
