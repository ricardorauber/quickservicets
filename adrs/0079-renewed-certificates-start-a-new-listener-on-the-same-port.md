# 0079 - Renewed certificates start a new listener on the same port

- Date: 2026-10-28
- Spec: 0272-certificate-reload
- Status: accepted

## Context
Spec 0272 R4 applies a valid new certificate set "through `setSecureContext` on the `node:https` path, and through
`server.reload` with the new `tls` options on the `Bun.serve` path", draining and restarting the worker only when the
runtime refuses. In Bun 1.4.2 both calls succeed without effect: `server.reload({ tls })` keeps the TLS options the
server started with, and `setSecureContext` on a `node:tls` server keeps the old certificate and client authorities.
Following the spec literally would leave every renewal unapplied while reporting success.

## Options considered
- A: Apply a new set by starting a second listener with the new certificates on the same port (`reusePort`, which the
  listeners use whenever certificates are watched) and stopping the old one from accepting, so new connections get
  the new certificates and requests in progress finish on the old listener; on both paths. The restart fallback stays
  for a listener that cannot start.
- B: Treat the silent refusal as a refusal and always drain and restart the worker: one restart per renewal, and a
  single-worker service exits with no supervisor to start it again.
- C: Call the APIs as the spec says and accept that renewals need a manual restart.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
With `server.tls` watched, the listener binds with `reusePort`. A reload swaps the listener on both server paths, the
listening object returned by `server.listen()` follows the current one for `port` and `stop`, and the drain-and-exit
fallback (one worker at a time, later workers waiting their turn) runs when starting the new listener fails.
