export type LogEntry = Record<string, unknown>;

export interface Logger {
  info(entry: LogEntry): void;
  warn(entry: LogEntry): void;
  error(entry: LogEntry): void;
}

const writeLine = (entry: LogEntry) => {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
};

/** Writes one JSON object per line to stdout. */
export const jsonLogger: Logger = {
  info: (entry) => writeLine({ level: "info", ...entry }),
  warn: (entry) => writeLine({ level: "warn", ...entry }),
  error: (entry) => writeLine({ level: "error", ...entry }),
};

/** Calls the logger without ever letting a logging failure escape. */
export function safeLog(logger: Logger, level: keyof Logger, entry: LogEntry): void {
  try {
    logger[level](entry);
  } catch {
    // Logging must never change the outcome of a request.
  }
}
