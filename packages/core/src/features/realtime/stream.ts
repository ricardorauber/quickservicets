import type { SseSendOptions, SseStream } from "../public.ts";

/** The interval timer a stream's heartbeat uses; tests give a fake one. */
export interface HeartbeatTimer {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const systemTimer: HeartbeatTimer = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** A stream with the response body that carries it. */
export interface OpenStream {
  stream: SseStream;
  /** The bytes the response sends. */
  body: ReadableStream<Uint8Array>;
  /** How many messages were sent, heartbeats and comments left out. */
  messages(): number;
}

const LINE_BREAK = /[\r\n]/;
const encoder = new TextEncoder();

/** The lines of a text, split at any line break. */
const linesOf = (text: string) => text.split(/\r\n|\r|\n/);

/** One Server-Sent Events message: its fields, then a `data:` line per line of the data, then a blank line. */
export function encodeMessage(data: unknown, options: SseSendOptions = {}): string {
  for (const field of ["event", "id"] as const) {
    const value = options[field];
    if (value !== undefined && LINE_BREAK.test(String(value))) throw new Error(`The SSE ${field} must not contain a line break`);
  }
  const text = typeof data === "string" ? data : JSON.stringify(data ?? null);
  const lines = [
    ...(options.event !== undefined ? [`event: ${options.event}`] : []),
    ...(options.id !== undefined ? [`id: ${options.id}`] : []),
    ...(options.retry !== undefined ? [`retry: ${Math.max(0, Math.floor(options.retry))}`] : []),
    ...linesOf(text).map((line) => `data: ${line}`),
  ];
  return `${lines.join("\n")}\n\n`;
}

/** A comment, one `:` line per line of the text, which clients ignore. */
export const encodeComment = (text: string) => `${linesOf(text).map((line) => `: ${line}`).join("\n")}\n\n`;

/**
 * Opens a stream: messages are queued in its body until the client reads them, a `: ping` comment is written every
 * `heartbeatMs` while it is open, and it closes once on `close()`, on a disconnect (the body is cancelled) or never.
 */
export function openStream(options: { heartbeatMs: number; timer?: HeartbeatTimer; onClose?: () => void }): OpenStream {
  const timer = options.timer ?? systemTimer;
  const abort = new AbortController();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let open = true;
  let sent = 0;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const write = (text: string) => {
    if (!open) return;
    try {
      controller?.enqueue(encoder.encode(text));
    } catch {
      // The body is gone: the client disconnected.
      finish(false);
    }
  };
  const finish = (closeBody: boolean) => {
    if (!open) return;
    open = false;
    timer.clearInterval(heartbeat);
    abort.abort();
    if (closeBody) {
      try {
        controller?.close();
      } catch {
        // Already closed by the client.
      }
    }
    resolveClosed();
    options.onClose?.();
  };
  const body = new ReadableStream<Uint8Array>({
    start(started) {
      controller = started;
    },
    cancel() {
      finish(false);
    },
  });
  const heartbeat = timer.setInterval(() => write(": ping\n\n"), options.heartbeatMs);
  const stream: SseStream = {
    send(data, sendOptions) {
      if (!open) return;
      write(encodeMessage(data, sendOptions));
      sent++;
    },
    comment(text) {
      write(encodeComment(text));
    },
    close: () => finish(true),
    signal: abort.signal,
    closed,
  };
  return { stream, body, messages: () => sent };
}
