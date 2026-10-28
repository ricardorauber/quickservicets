import { defineConfig, memoryAdapter } from "@quickservicets/core";

export default defineConfig({
  database: memoryAdapter(),
  proxy: {
    routes: {
      // `bun run catalog` serves the catalog upstream on port 4101.
      catalog: { path: "/catalog/*", target: "http://127.0.0.1:4101" },
    },
  },
});
