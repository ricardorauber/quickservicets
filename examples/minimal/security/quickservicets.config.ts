import { defineConfig, memoryAdapter } from "@quickservicets/core";

// The security native is on by default: only CORS is opened, for the browser app of the project.
export default defineConfig({
  database: memoryAdapter(),
  security: { cors: { origins: ["http://localhost:5173"] } },
  audit: {},
});
