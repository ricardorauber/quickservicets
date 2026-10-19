# 0001 - Ambiguous renames in generated migrations become drop + add

- Date: 2026-10-15
- Spec: 0019-migration-add
- Status: accepted

## Context
Spec 0019 generates `up` and `down` with drizzle-kit's programmatic API. When one diff both removes and adds
columns (or tables), drizzle-kit cannot tell a rename from a drop + add and opens an interactive prompt. Outside a
TTY (the `dev` watcher, CI, tests) that prompt fails, so the spec could not be followed directly.

## Options considered
- A: Always generate drop + add without prompting, marked with the data-loss warning; developers edit the
  migration file to use a rename when they want to keep data — deterministic in every environment.
- B: Prompt when a TTY is available and fall back to drop + add otherwise — behavior depends on the environment.
- C: A new `@renamedFrom` tag that declares renames explicitly — deterministic, but a new feature needing its own spec.

## Decision
"Always drop + add, editable" — option A.

## Consequences
The generator diffs in two steps (removals first, then additions) so drizzle-kit never sees an ambiguous change and
never prompts. Renamed fields and entities produce drop + add statements preceded by `// WARNING: possible data loss`;
the generated `.ts` file is meant to be edited when a rename must keep data. No spec change is needed.
