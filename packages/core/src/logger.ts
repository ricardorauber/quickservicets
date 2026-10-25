import { writeSync } from "node:fs";

export type LogEntry = Record<string, unknown>;

export interface Logger {
  info(entry: LogEntry): void;
  warn(entry: LogEntry): void;
  error(entry: LogEntry): void;
}

/** A buffer above this many characters is written at once instead of at the end of the event-loop turn. */
export const LOG_FLUSH_THRESHOLD = 64 * 1024;

/** How long a write to a full stdout pipe waits for the reader before the chunk is given up. */
const STALLED_WRITE_MS = 1000;

/**
 * Writes `text` to stdout synchronously, so it is in the pipe (or file) when this returns, even right before the process
 * exits. Bun keeps stdout non-blocking, so a full pipe is retried until its reader catches up; a pipe that makes no
 * progress for a second fails the write.
 */
function writeStdout(text: string): void {
  const bytes = Buffer.from(text);
  let offset = 0;
  let stalledSince: number | undefined;
  while (offset < bytes.length) {
    try {
      offset += writeSync(1, bytes, offset);
      stalledSince = undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
      stalledSince ??= Date.now();
      if (Date.now() - stalledSince > STALLED_WRITE_MS) throw error;
      Bun.sleepSync(1);
    }
  }
}

export interface BufferedJsonLogger extends Logger {
  /** Writes the buffered lines now. */
  flush(): void;
}

export interface BufferedJsonLoggerOptions {
  /** Receives the buffered lines (default: stdout). A failing write loses only the lines it carried. */
  write?: (text: string) => void;
  /** Runs the end-of-turn flush (default: `setImmediate`). */
  schedule?: (flush: () => void) => void;
  /** Called once, with the flush, when the first line is buffered (default: flush on process exit). */
  onFirstLine?: (flush: () => void) => void;
}

/**
 * One JSON object per line, buffered: the lines of an event-loop turn are written together at its end, or as soon as
 * the buffer passes `LOG_FLUSH_THRESHOLD`. `error` entries are written right away, with the lines before them.
 */
export function createBufferedJsonLogger({
  write = writeStdout,
  schedule = setImmediate,
  onFirstLine = (flush) => process.on("exit", flush),
}: BufferedJsonLoggerOptions = {}): BufferedJsonLogger {
  let buffer = "";
  let scheduled = false;
  let started = false;

  const flush = () => {
    if (buffer === "") return;
    const text = buffer;
    buffer = "";
    try {
      write(text);
    } catch {
      // Logging must never change the outcome of a request; the next lines start a new buffer.
    }
  };
  const endOfTurn = () => {
    scheduled = false;
    flush();
  };
  const append = (entry: LogEntry) => {
    buffer += `${JSON.stringify(entry)}\n`;
    if (!started) {
      started = true;
      onFirstLine(flush);
    }
    if (buffer.length > LOG_FLUSH_THRESHOLD) {
      flush();
    } else if (!scheduled) {
      scheduled = true;
      schedule(endOfTurn);
    }
  };

  return {
    info: (entry) => append({ level: "info", ...entry }),
    warn: (entry) => append({ level: "warn", ...entry }),
    error: (entry) => {
      append({ level: "error", ...entry });
      flush();
    },
    flush,
  };
}

const defaultLogger = createBufferedJsonLogger();

/** Writes one JSON object per line to stdout, buffered per event-loop turn (see `createBufferedJsonLogger`). */
export const jsonLogger: Logger = defaultLogger;

/** Writes what the default JSON logger has buffered, before a graceful shutdown or an exit. */
export function flushLogs(): void {
  defaultLogger.flush();
}

/**
 * Marks the request log entries the server writes: they hold no free-form values, so a masking logger passes them on
 * without walking them.
 */
export const REQUEST_LOG = Symbol.for("quickservice.requestLog");

/** Masks secrets and sensitive values in what the service logs, stores in job runs and returns in development errors. */
export interface LogMasker {
  /** A copy of a log entry (or a stored value) with its secrets masked, or the value itself when nothing changed. */
  entry<T>(value: T): T;
  /** Text with known secret values masked. */
  text(value: string): string;
}

/** A logger passing every entry through the masker first, except the server's request log entries. */
export function maskedLogger(logger: Logger, masker: LogMasker): Logger {
  const write = (level: keyof Logger) => (entry: LogEntry) => logger[level]((entry as Record<symbol, unknown>)[REQUEST_LOG] ? entry : masker.entry(entry));
  return { info: write("info"), warn: write("warn"), error: write("error") };
}

/** Calls the logger without ever letting a logging failure escape. */
export function safeLog(logger: Logger, level: keyof Logger, entry: LogEntry): void {
  try {
    logger[level](entry);
  } catch {
    // Logging must never change the outcome of a request.
  }
}
