---
title: Coding agents
description: Use QuickService.ts with Claude Code, Codex, Cursor and other coding agents, through the quickservicets skill, AGENTS.md and llms.txt.
sidebar:
  order: 60
---

Coding agents write better QuickService.ts code when they know its workflow and rules: create projects with `init`, describe entities as types, rebuild after every change, and let the CLI write the migrations. QuickService.ts ships that knowledge in three forms, so any agent can find it.

| Form | For | Where |
| --- | --- | --- |
| The `quickservicets` skill | Claude Code | The Claude Code plugin in the repository |
| `AGENTS.md` | Codex, Cursor, Claude Code and any agent that reads it | The root of the repository |
| `llms.txt` | Any LLM or agent that reaches the docs site | [`/llms.txt`](/llms.txt), with every page as Markdown |

All three come from the same short agent guide topics, which also ship in `@quickservicets/cli`: `overview`, `quickstart`, `entities`, `endpoints-and-hooks`, `config-and-env`, `features`, `testing`, `deploy` and `troubleshooting`.

## Claude Code

Install the plugin from the repository, in a Claude Code session:

```text
/plugin marketplace add ricardorauber/quickservicets
/plugin install quickservicets@quickservicets
```

The first command adds the repository as a plugin marketplace (a local clone works too: `/plugin marketplace add ./quickservicets`), and the second installs the `quickservicets` plugin, which holds one skill. From the terminal, `claude plugin marketplace add ricardorauber/quickservicets` and `claude plugin install quickservicets@quickservicets` do the same.

Claude Code loads the skill by itself when a request matches its description: building a backend, API or service with QuickService.ts, adding an entity, endpoint, hook, job or feature to a QuickService.ts project, or working in a project with a `quickservicets.config.ts`.

### What the skill does

The skill is a `SKILL.md` of under 200 lines with:

- **When to use QuickService.ts** and when to pick something else.
- **The workflow:** `bunx quickservicets init <name>` (on the in-memory database; `--db <database>` chooses another), entities in `entities/`, `bun run build`, `bun run quickservicets migration add <Name>` and `bun run quickservicets migrate`, then `bun run dev`.
- **The rules:** never edit `.generated/`, use the CLI for migrations, run `quickservicets build` after changing entities, pass `--db` to `init`, read records with `toArray()`, and test with `startTestService`.
- **The topics:** the nine agent guide topics, as files next to the skill, which Claude Code reads only when the task needs one.

Without the plugin, Claude Code still reads `CLAUDE.md`, which in the repository imports `AGENTS.md`.

## In your projects

Every project `quickservicets init` creates is ready for coding agents: it gets an `AGENTS.md` written for that project (its name, database, commands, folders and rules), a `CLAUDE.md` with `@AGENTS.md`, and the skill with its topics in `.claude/skills/quickservicets/`, so Claude Code loads the skill in the project without the plugin. `quickservicets init --no-agents` leaves them out.

The files keep a generated part above `<!-- quickservicets:end -->`; write your own instructions below it. After upgrading QuickService.ts, `bun run quickservicets agents update` refreshes the generated part of each file, keeps what you wrote below the marker, prints the files that changed, and skips a file without the marker. See [Installation and init](/getting-started/installation/#files-for-coding-agents).

## Other agents

- **`AGENTS.md`**: Codex, Cursor and the other agents that follow the `AGENTS.md` convention read the file at the root of the repository. It explains what QuickService.ts is, when to use it and the quickstart, links to the other topics, and describes how to work on the repository itself.
- **`llms.txt`**: the docs site serves [`/llms.txt`](/llms.txt) (an index of every page with its description), `/llms-full.txt` (the agent topics and every page in one file) and `/llms-small.txt` (the agent topics, getting started and the CLI, config and tags reference, for small context windows). Every page is also served as Markdown at its path plus `.md`, like `/guides/queues.md`.

Point an agent that has neither at `/llms.txt`, or paste the `quickstart` topic into its instructions.

## See also

- [Installation and init](/getting-started/installation/): creating a project with `bunx quickservicets init`.
- [CLI reference](/reference/cli/): every command the skill and the topics mention.
