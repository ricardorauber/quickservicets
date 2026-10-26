# 0065 - Agent files say "entities" where the specs say "collections"

- Date: 2026-10-26
- Spec: 0835-claude-code-skill
- Status: accepted

## Context
Specs 0833 (R1), 0835 (R1) and 0836 (R1) describe entity files as "collections" ("run `quickservicets build` after
changing collections", a `collections/` folder in new projects). QuickService.ts has no `collections/` folder: entity
types live in `entities/`, and "collection" names only the plural route and table name of an entity (`@collection`).
Agents that follow the specs' wording literally would create files the build never reads.

## Options considered
- A: Use the current names in every agent file — `entities/`, "after changing entities" — and keep "collection" for
  the `@collection` tag only; the topics, the skill and the project files match what the framework does.
- B: Write "collections" as the specs do — matches the wording, but sends agents to a folder that does not exist.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
The skill's rules, the topics and the project `AGENTS.md` written by `init` name `entities/`. The specs could be updated
to say "entities".
