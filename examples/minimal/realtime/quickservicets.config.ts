import { defineConfig, memoryAdapter } from "@quickservicets/core";

export default defineConfig({
  database: memoryAdapter(),
  events: {},
  // The rooms socket is for signed-in users; the tests sign them in with testAuth().
  auth: {},
  realtime: {},
});
