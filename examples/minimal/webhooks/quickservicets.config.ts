import { defineConfig, memoryAdapter, string } from "@quickservicets/core";
import { testAuth } from "@quickservicets/core/testing";

export default defineConfig({
  database: memoryAdapter(),
  env: {
    GITHUB_WEBHOOK_SECRET: string().default("github-example-secret"),
    PARTNER_WEBHOOK_SECRET: string().default("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"),
  },
  // Users sign in with the x-test-user header outside production; a real project registers its own provider.
  auth: { providers: process.env.NODE_ENV === "production" ? [] : [testAuth()] },
  webhooks: { events: ["invoice.paid"] },
});
