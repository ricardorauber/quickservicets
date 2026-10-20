import { expect, test } from "bun:test";
import { join } from "node:path";
import type { Repositories } from "./hooks.ts";
import { createServer } from "./http/server.ts";
import { createBufferedJsonLogger, LOG_FLUSH_THRESHOLD, type LogEntry, type Logger } from "./logger.ts";

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const unbufferedLine = (level: string, entry: LogEntry) => `${JSON.stringify({ level, ...entry })}\n`;

function capture() {
  const writes: string[] = [];
  return { writes, write: (text: string) => void writes.push(text) };
}

/** Records each entry as the unbuffered logger would have written it, then passes it on. */
function tee(logger: Logger, lines: string[]): Logger {
  return {
    info: (entry) => (lines.push(unbufferedLine("info", entry)), logger.info(entry)),
    warn: (entry) => (lines.push(unbufferedLine("warn", entry)), logger.warn(entry)),
    error: (entry) => (lines.push(unbufferedLine("error", entry)), logger.error(entry)),
  };
}

test("lines are buffered and written together once per event-loop turn, as the unbuffered logger wrote them", async () => {
  const { writes, write } = capture();
  const logger = createBufferedJsonLogger({ write, onFirstLine: () => {} });
  logger.info({ message: "a" });
  logger.warn({ message: "b", n: 1 });
  expect(writes).toEqual([]);
  await nextTurn();
  expect(writes).toEqual([unbufferedLine("info", { message: "a" }) + unbufferedLine("warn", { message: "b", n: 1 })]);

  // 1,000 requests give 1,000 lines, byte for byte and in order, in far fewer writes.
  writes.length = 0;
  const expected: string[] = [];
  const server = createServer({ routes: [], repos: {} as Repositories, config: { production: true, logger: tee(logger, expected) } });
  for (let batch = 0; batch < 10; batch++) {
    await Promise.all(Array.from({ length: 100 }, () => server.fetch(new Request("http://localhost/nope"))));
  }
  await nextTurn();
  const output = writes.join("");
  expect(output.split("\n").filter(Boolean)).toHaveLength(1000);
  expect(output).toBe(expected.join(""));
  expect(writes.length).toBeLessThan(1000);
});

test("a buffer that passes the size threshold is written at once", () => {
  const { writes, write } = capture();
  const logger = createBufferedJsonLogger({ write, schedule: () => {}, onFirstLine: () => {} });
  const entry = { message: "x".repeat(1000) };
  const line = unbufferedLine("info", entry);
  const fit = Math.floor(LOG_FLUSH_THRESHOLD / line.length);
  for (let index = 0; index < fit; index++) logger.info(entry);
  expect(writes).toEqual([]);
  logger.info(entry);
  expect(writes).toEqual([line.repeat(fit + 1)]);
  logger.info(entry);
  expect(writes).toHaveLength(1);
});

test("the buffer is written on exit, on a graceful shutdown and right after an error entry", async () => {
  // Error entries are written synchronously, together with the lines buffered before them.
  const { writes, write } = capture();
  const logger = createBufferedJsonLogger({ write, schedule: () => {}, onFirstLine: () => {} });
  logger.info({ message: "before" });
  logger.error({ message: "boom" });
  expect(writes).toEqual([unbufferedLine("info", { message: "before" }) + unbufferedLine("error", { message: "boom" })]);

  // The default logger, in a real process with stdout piped, on exit and on SIGTERM.
  const core = join(import.meta.dir, "index.ts");
  const run = async (script: string) => {
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "inherit" });
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { lines: output.split("\n").filter(Boolean).map((line) => JSON.parse(line) as LogEntry), code };
  };
  const onExit = await run(`
    import { jsonLogger } from ${JSON.stringify(core)};
    for (let index = 0; index < 2000; index++) jsonLogger.info({ message: "line", index, padding: "x".repeat(200) });
    process.exit(0);
  `);
  expect(onExit.code).toBe(0);
  expect(onExit.lines).toHaveLength(2000);
  expect(onExit.lines.at(-1)).toMatchObject({ level: "info", index: 1999 });

  const onShutdown = await run(`
    import { handleShutdownSignals, jsonLogger } from ${JSON.stringify(core)};
    handleShutdownSignals(async () => { jsonLogger.info({ message: "stopped" }); });
    jsonLogger.info({ message: "request" });
    process.kill(process.pid, "SIGTERM");
    setInterval(() => {}, 1000);
  `);
  expect(onShutdown.code).toBe(0);
  expect(onShutdown.lines.map((line) => line.message)).toEqual(["request", "stopped"]);
});

test("a failing write changes no response and loses no later line", async () => {
  const writes: string[] = [];
  let failing = true;
  const logger = createBufferedJsonLogger({
    write: (text) => {
      if (failing) throw new Error("stdout closed");
      writes.push(text);
    },
    onFirstLine: () => {},
  });
  const server = createServer({ routes: [], repos: {} as Repositories, config: { production: true, logger } });
  const first = await server.fetch(new Request("http://localhost/nope"));
  expect(first.status).toBe(404);
  logger.error({ message: "while failing" });
  await nextTurn();
  expect(writes).toEqual([]);

  failing = false;
  const second = await server.fetch(new Request("http://localhost/nope"));
  expect(second.status).toBe(404);
  await nextTurn();
  expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0]!)).toMatchObject({ level: "info", status: 404 });
});
