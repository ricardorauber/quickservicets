# 0074 - The native closes oversized frames with 1009 up to twice the limit; Bun ends larger ones

- Date: 2026-10-27
- Spec: 0251-websocket-endpoints
- Status: accepted

## Context
Spec 0251 R6 makes `websockets.maxMessageSize` (default `1MB`) Bun's `maxPayloadLength`, with larger frames closing
the socket with 1009. Bun 1.4.2 ends a connection whose frame exceeds `maxPayloadLength` without sending a close
frame, so the client and the server's `close` handler see 1006, never 1009. Spec 0256 R2 also needs the native to
enforce a per-route limit below the global one on each frame.

## Options considered
- A: Give Bun twice the limit and check every frame in the native: a frame above `maxMessageSize` closes with 1009
  `Message too big`, and only frames above twice the limit are cut by Bun (1006); one length check per frame, and the
  per-route limits of spec 0256 use the same check.
- B: Keep Bun's limit equal to `maxMessageSize`: every oversized frame ends with 1006, contradicting R6 and AC4.
- C: No Bun limit at all: an unbounded frame could exhaust a worker's memory.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`maxPayloadLength` is `2 × maxMessageSize`; the reference describes the option as the largest frame accepted, with
1009 for larger frames and the connection ended above twice the limit.
