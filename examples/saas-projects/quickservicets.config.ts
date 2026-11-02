import { defineConfig, postgresAdapter, secret } from "@quickservicets/core";

export default defineConfig({
  // The service's own database: the shared tables (plans, members, tenants) and the schemas of the smaller plans.
  database: postgresAdapter({ url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/saas" }),
  // The template of the enterprise tenants' own databases, like postgres://…/saas_{tenant}, read from TENANT_DATABASE_TEMPLATE.
  secrets: {},
  tenancy: {
    from: ["subdomain", "header"],
    domain: process.env.APP_DOMAIN ?? "saas.localhost",
    // Smaller plans share the service's database through a schema each; the enterprise plan gets its own database.
    strategy: ({ tenant }) => (tenant?.plan === "enterprise" ? "database" : "schema"),
    connection: secret("env://TENANT_DATABASE_TEMPLATE"),
  },
  queues: {},
  events: { outbox: true },
});
