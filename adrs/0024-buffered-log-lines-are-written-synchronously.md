# 0024 - The default logger writes its buffer to stdout synchronously

- Date: 2026-10-19
- Spec: 0115-buffered-request-logging
- Status: accepted

## Context
Spec 0115 R3 asks the buffered default logger to flush synchronously on process exit, on graceful shutdown and right
after an `error` entry. Bun keeps stdout non-blocking, and `process.stdout.write` to a pipe queues what the pipe does
not take at once: measured with Bun 1.4.2, a 1 MB write followed by `process.exit()` delivers only the first 64 KB (the
pipe's capacity) to a slow reader, so a flush through `process.stdout.write` is not synchronous and lines can be lost at
exit. The spec does not say which write call to use.

## Options considered
- A: Write each flushed buffer with `fs.writeSync(1, ...)`, looping over partial writes and retrying `EAGAIN` with 1 ms
  pauses; a pipe that takes nothing for a second fails the write (the chunk is dropped, later lines continue) — every
  flush is on stdout when it returns, at exit too; a slow log reader slows the event loop for at most that second per
  flush, as Node's blocking stdout pipes do.
- B: Keep `process.stdout.write` for every flush — never blocks the event loop, but a flush is not synchronous and the
  last 64 KB-plus of lines can disappear on exit, which R3 forbids.
- C: `process.stdout.write` per turn and `fs.writeSync` only on exit and shutdown — lines still queued inside Bun's
  writer can be lost or overtaken by the final write, so the order of R2 is not guaranteed.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`createBufferedJsonLogger` in `packages/core/src/logger.ts` writes through a synchronous stdout writer by default.
`handleShutdownSignals` and the worker primary call `flushLogs()` before exiting, and the logger also flushes on the
process `exit` event. A process killed with `SIGKILL` can lose the lines of its last event-loop turn.
