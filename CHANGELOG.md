# Changelog

All notable changes to the published packages (`quickservicets`, `@quickservicets/core` and `@quickservicets/cli`) are listed here. The packages share one version.

## Unreleased

### Breaking changes

- **CLI exit codes:** usage errors (an unknown command or flag, a missing argument) now exit with 2 instead of 1, configuration errors (no or an invalid `quickservicets.config.ts`, an invalid environment variable) with 3, and an unreachable database with 4. Scripts that checked for 1 should check for a non-zero code, or for the specific one.

### Added

- `--json` on the commands that report results (`build`, `migration add`, `migration list`, `migrate`, `job list`, `job runs`, `env check`, `agents update`, `queue list`, `queue dead`, `flags list`, `events outbox`): one JSON document on stdout, `{ "ok": true, ... }` or `{ "ok": false, "error": { "code", "message" } }`, with the logs on stderr. The CLI reference documents each command's document and the exit codes.
- No command waits for input when stdin is not a terminal, `--yes` is given or `CI=true` is set: `init` without `--db` uses `memory`, and a question with no safe answer exits 2 with `<command> needs <flag> when not interactive`. Feature commands ask through `ctx.prompt(question, choices, { flag, default })` and report with `ctx.result(...)` and a `json` shape in `defineCommand`.
- Agent guide topics for coding agents in `@quickservicets/cli` (`agent-docs/`): overview, quickstart, entities, endpoints and hooks, config and environment, features, testing, deploy and troubleshooting, each a short page of steps, copyable commands and a "Do not" list.
- The repository has an `AGENTS.md` generated from those topics, and a `CLAUDE.md` that imports it.
- A Claude Code plugin in the repository with the `quickservicets` skill: `/plugin marketplace add ricardorauber/quickservicets`, then `/plugin install quickservicets@quickservicets`. The new [Coding agents](https://github.com/ricardorauber/quickservicets/blob/main/docs/src/content/docs/guides/coding-agents.md) guide explains it, `AGENTS.md` and `llms.txt`.
- `quickservicets init` writes `AGENTS.md`, `CLAUDE.md` and the `quickservicets` skill in `.claude/skills/quickservicets/` for the new project; `--no-agents` leaves them out, and `quickservicets agents update` refreshes their generated part after an upgrade, keeping what you wrote below `<!-- quickservicets:end -->`.
- `quickservicets docs` lists the agent guide topics, `quickservicets docs <topic>` prints one (`--full` prints the docs page it links to, or a page by name like `queues`), and `quickservicets docs search <term>` searches the topics and the CLI, config and tags reference, offline and matching the installed version: the CLI package bundles the topics and every docs page as Markdown.
- The docs site serves `llms.txt`, `llms-full.txt` and `llms-small.txt` (llmstxt.org) and a Markdown copy of every page at its path plus `.md`, linked from the footer.

### Fixed

- `startTestService` from `@quickservicets/cli/testing` works in projects that install the packages from npm; it linked paths that only exist in the repository.

## 0.2.0 - 2026-10-26

### Breaking changes

- **Fluent queries:** the terminal that returns records is now `toArray()`. `all(condition)` now answers whether every matched record satisfies a condition, and `all()` without a condition is a type error that points to `toArray()`.
  ```ts
  // 0.1.0
  const admins = await repos.users.where((u) => u.role.eq("admin")).all();
  // 0.2.0
  const admins = await repos.users.where((u) => u.role.eq("admin")).toArray();
  ```
- **Config:** `repositories.findAllMax` is now `repositories.toArrayMax` (environment variable `QS_REPOSITORIES_TO_ARRAY_MAX`). The old key fails with a message naming the new one.
- **Queues:** queue messages record the user and tenant that added them, in a new nullable `actor` column of `queue_messages`. Projects that use queues need a migration: run `quickservicets build`, then `quickservicets migration add QueueMessageActor` and `quickservicets migrate`.

### Added

- `none(condition?)`, `any(condition?)` and `all(condition)` on fluent queries, and `.not()` on any condition, compound ones included, with JavaScript null semantics on every database.
- `repos.<entity>.any(...)`, `all(...)`, `none(...)` and `count(...)` directly on repositories.
- Projects created by `init` get `@types/bun`, `typescript` and a `typecheck` script, and their `tsconfig.json` covers every convention folder, so they type-check in the editor and with `bun run typecheck`.
- The attack suite (`runAttackSuite`) runs with the native features on, security included, and takes a `config` option.

### Fixed

- Documented `curl` commands with filters in the query string pass `-g`, so curl no longer rejects the brackets.

## 0.1.0 - 2026-10-26

First release on npm.
