# 0081 - The memory config shows the switch line with process.env

- Date: 2026-10-29
- Spec: 0877-init-without-prompts-and-minimal-memory-project
- Status: accepted

## Context
Spec 0877 R2 asks the memory project's `quickservicets.config.ts` to show how to switch databases with one line,
`database: sqliteAdapter({ path: env.DATABASE_PATH })`. Inside the config file `env` cannot be read: it holds the
declared variables only once the configuration is resolved, and reading it earlier throws `env.DATABASE_PATH was read
before the configuration was resolved; use process.env inside quickservicets.config.ts`. `DATABASE_PATH` is not a
declared variable either. Uncommenting the line as written would break the build.

## Options considered
- A: Show the line with `process.env`, as the SQLite project `init --db sqlite` writes, with a fallback so it works
  without a `.env`: `database: sqliteAdapter({ path: process.env.DATABASE_PATH ?? "data.db" })`, and say to import
  the adapter. The line works when uncommented.
- B: Show the line exactly as the spec writes it: it fails as soon as someone follows it.
- C: Change `env` so it can be read while the config file loads: a change to spec 0139's contract outside this spec.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
The memory config's comment shows `database: sqliteAdapter({ path: process.env.DATABASE_PATH ?? "data.db" })` and
the import to add; a test uncomments it and loads a SQLite config. Spec 0877 R2 should name this line when it is next
updated.
