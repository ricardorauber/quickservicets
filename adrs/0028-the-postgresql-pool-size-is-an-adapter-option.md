# 0028 - The PostgreSQL pool size is a `max` option of `postgresAdapter`

- Date: 2026-10-19
- Spec: 0117-server-workers
- Status: accepted

## Context
Spec 0117 R3 divides the PostgreSQL pool size across the workers "so the total stays at the configured size". The
adapter had no pool setting: it created `Bun.SQL` with its default of 10 connections, so there was no configured size
to keep, and the adapter did not know how many processes would share it.

## Options considered
- A: A `max` option on `postgresAdapter` (default 10, Bun's own default), and a `workers` field in the adapter's
  `connect` options; the adapter opens `ceil(max / workers)` connections — the size is set where the database is
  configured, and other adapters can ignore the field.
- B: Always divide Bun's default of 10, with no option — nothing new to document, but the total cannot be tuned, and
  services that need more connections per CPU have no way to get them.
- C: Read the size from a `max` parameter in the connection URL — no API change, but it is hidden in a secret and is
  not typed or documented with the other keys.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`PostgresAdapterOptions.max` and `ConnectOptions.workers` exist; the generated server passes `server.workers` to
`connect`. The MongoDB adapter ignores `workers` (R3 covers PostgreSQL only).
