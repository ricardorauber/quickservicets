import { defineConfig, memoryAdapter } from "@quickservicets/core";

export default defineConfig({
  database: memoryAdapter(),
  // The client is on by default; the key only sets its options. The upstream runs on this machine, which SSRF
  // protection blocks unless allowed.
  http: { timeout: "5s", allow: ["loopback"] },
});
