import { addAuthScheme, defineConfig, memoryAdapter, secret } from "@quickservicets/core";
import { apiKeyProvider } from "./lib/api-key.ts";

export default defineConfig({
  database: memoryAdapter(),
  env: { API_KEY: secret().optional() },
  auth: { providers: [apiKeyProvider()] },
  // The API docs say how to send the key, so the docs page and generated clients can authenticate.
  docs: { openapi: (doc) => addAuthScheme(doc, "apiKey", { type: "apiKey", in: "header", name: "x-api-key" }) },
});
