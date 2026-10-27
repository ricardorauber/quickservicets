import { defineConfig, memoryAdapter } from "@quickservicets/core";

export default defineConfig({
  database: memoryAdapter(),
  "demo-user": {},
  http: {
    // The upstream runs on this machine, which SSRF protection blocks unless allowed.
    allow: ["loopback"],
    services: {
      quotes: { url: process.env.QUOTES_URL ?? "http://localhost:4100", retry: true, circuitBreaker: true, cache: true, propagate: ["user"] },
    },
  },
});
