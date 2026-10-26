# 0050 - `@<tag> on` is accepted as the explicit form of a bare feature tag

- Date: 2026-10-26
- Spec: 0200-entity-history-tables
- Status: accepted

## Context
Spec 0200 R6 keeps a `@hidden` or `@sensitive` field in history versions when it is tagged `@history on`. Feature tags
(spec 0144 R2) are written as `@name`, `@name off` or `@name key=value`, so the build rejected `@history on` with
`expects off or key=value pairs, got "on"`.

## Options considered
- A: Accept `@name on` for every feature tag as the explicit form of `@name` (on, with the global options) — one rule
  for all tags, and `on` mirrors the existing `off` keyword.
- B: Give the `history` tag a special shorthand option for `on` — needs an option that does not exist and only helps
  one tag.
- C: Use the bare `@history` on fields to mean `on` — works, but the spec and its guide name `@history on`.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
The tag parser treats the text `on` like an empty text. A tag whose shorthand value could be `on` is not affected in
practice; no native declares one.
