# 0007 - Files in /entities that only export enums are shared enums, not entities

- Date: 2026-10-16
- Spec: 0067-entity-enums-and-aliases
- Status: accepted

## Context
Spec 0067 R3 lets an entity import its enum or union alias from any project file. Spec 0004 treats every file in
`/entities` as an entity file that must export one entity type named after the file, so an enum kept next to the
entities (e.g. `entities/ModuleAction.ts` exporting `enum ModuleAction`) failed the build with "must export exactly
one entity type".

## Options considered
- A: Files in `/entities` that export only enums or string-literal union aliases are skipped as entity files and
  can be imported as shared enums; a file exporting nothing still fails as before.
- B: Keep every `/entities` file an entity; enums must live in another folder, with the error suggesting it.
- C: Enums only in the entity file that uses them or outside `/entities`.

## Decision
The user chose A ("Treat it as a shared enum").

## Consequences
The entity parser skips enum-only files in `/entities`. Spec 0004 (every file is an entity) and spec 0067 should
mention this exception; an `update-spec` can align the wording.
