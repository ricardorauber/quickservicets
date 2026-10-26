# 0068 - `init` uses the memory database when it cannot ask

- Date: 2026-10-26
- Spec: 0838-cli-json-and-non-interactive
- Status: accepted

## Context
Spec 0838 R3 says a prompt with a safe default takes it when the CLI is not interactive, and AC3 expects
`quickservicets init demo < /dev/null` without `--db` to take "the default database". `init` had no default: it always
asked which of `postgres`, `mongodb`, `sqlite` and `memory` to use.

## Options considered
- A: `memory` — needs nothing installed or running and no migrations, so the project builds and serves right away; the
  docs already call it the quickest way to start. The data is lost on restart, which the next steps make clear.
- B: `sqlite` — persistent and still needs no server, but every model change needs a migration before the first request.
- C: `postgres` — the production choice, but the project cannot run until a server exists and `.env` is filled in.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`DEFAULT_DATABASE` in `packages/cli/src/init/init.ts` is `memory`; `init` prints
`Not interactive: using memory for --db` on stderr when it takes it. The agent topics still tell agents to always pass
`--db`.
