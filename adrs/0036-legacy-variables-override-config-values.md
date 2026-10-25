# 0036 - Legacy environment variables override config values

- Date: 2026-10-25
- Spec: 0139-environment-overrides-and-option-reference
- Status: accepted

## Context
Spec 0139 sets the precedence "variable > legacy alias > config value > default" (R4) and keeps `PORT`, `QS_WORKERS`,
`DATABASE_SCHEMA`, `JOBS_ENABLED`, `FILES_SIGNING_SECRET` and `NODE_ENV=production` as aliases (R5). Before it,
`PORT`, `FILES_SIGNING_SECRET` and `NODE_ENV` applied only when the config left their key unset, and two existing
tests asserted that: a `server.port` in the config won over `PORT`, and `production: false` won over
`NODE_ENV=production`. `server.workers` and `schema` keep their own messages (`"auto"`, the schema name rule), so they
cannot be parsed by the generic option schemas alone.

## Options considered
- A: Apply R4 to every alias: `PORT`, `FILES_SIGNING_SECRET` and `NODE_ENV=production` now override the config, and
  the two tests are updated to the new precedence. `server.workers` (`QS_SERVER_WORKERS`, then `QS_WORKERS`) and
  `schema` (`QS_SCHEMA`, then `DATABASE_SCHEMA`) keep their resolvers, which read their variables in that order.
  One rule for every key, as the phase 0 decisions state; operators can always override code.
- B: Keep the old behavior for those three aliases and apply R4 only to `QS_*` names — no change for existing
  deployments that set both, but two precedence rules to document and R4 not met.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`config.test.ts` now expects `PORT` to win over `server.port` and no longer expects `production: false` to win over
`NODE_ENV=production`. The doc comments of `server.port`, `production` and `files.signingSecret`, the configuration
guide and the API docs tutorial describe the new precedence. Worker processes receive both `QS_WORKERS` and
`QS_SERVER_WORKERS`, so a `QS_SERVER_WORKERS=auto` set by the operator does not make them recount the CPUs.
