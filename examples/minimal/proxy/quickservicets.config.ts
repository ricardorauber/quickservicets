import { defineConfig, memoryAdapter, secret } from "@quickservicets/core";

export default defineConfig({
  database: memoryAdapter(),
  env: { GATEWAY_SECRET: secret().optional().describe("Signs the identity the gateway forwards; the orders upstream verifies it.") },
  auth: {},
  proxy: {
    identity: { secret: process.env.GATEWAY_SECRET },
    routes: {
      // `bun run catalog` serves the catalog on port 4101; it gets /products for /catalog/products.
      catalog: { path: "/catalog/*", target: "http://127.0.0.1:4101", stripPrefix: true, rateLimit: { limit: "60/min" } },
      // `bun run orders` serves the orders on port 4102, trusting the signed user and tenant.
      orders: { path: "/orders/*", target: "http://127.0.0.1:4102", auth: "required", forward: ["user", "tenant"] },
    },
  },
});
