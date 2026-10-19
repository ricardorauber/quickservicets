// WHAT-IF: the same JSON lines, but buffered and written once per event-loop turn instead of one write per request.
import { defineConfig, localStorage, postgresAdapter } from "@quickservice/core";

let buffer: string[] = [];
let scheduled = false;
const flush = () => {
  scheduled = false;
  const lines = buffer;
  buffer = [];
  process.stdout.write(lines.join(""));
};
const line = (level: string) => (entry: Record<string, unknown>) => {
  buffer.push(`${JSON.stringify({ level, ...entry })}\n`);
  if (!scheduled) {
    scheduled = true;
    setImmediate(flush);
  }
};

export default defineConfig({
  database: postgresAdapter({ url: process.env.DATABASE_URL ?? "postgres://bench:bench@localhost:55432/bench" }),
  server: { port: Number(process.env.PORT ?? 8080) },
  storage: { default: localStorage({ dir: process.env.UPLOAD_DIR ?? "uploads" }) },
  logger: { info: line("info"), warn: line("warn"), error: line("error") },
});
