import { join } from "node:path";
import { defineConfig, postgresAdapter, secret } from "@quickservicets/core";
import { localVault } from "./vault/local-vault.ts";

export default defineConfig({
  // The database URL is read from DATABASE_URL through the built-in env:// provider.
  database: postgresAdapter({ url: secret("env://DATABASE_URL") }),
  secrets: { providers: [localVault(join(import.meta.dir, "local-vault.json"))] },
  http: {
    services: {
      // The API key is the content of secrets/api-key, which bun run seed creates.
      payments: { url: "https://payments.example.com", auth: { apiKey: { header: "x-api-key", value: secret("file://secrets/api-key") } } },
      // The partner token rotates when local-vault.json changes.
      partner: { url: "https://partner.example.com", auth: { bearer: secret("local://partner#token") } },
    },
  },
});
