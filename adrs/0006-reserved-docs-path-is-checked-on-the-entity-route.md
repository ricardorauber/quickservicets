# 0006 - The reserved /docs path is checked on the entity route, not the file name

- Date: 2026-10-16
- Spec: 0033-docs-routes-scalar
- Status: accepted

## Context
Spec 0033 AC5 says `/entities/docs.ts` makes the build fail naming the file and `/docs`. Entity file names must be
PascalCase (spec 0004), so `entities/docs.ts` already fails earlier with the naming error and never reaches the
reserved-path check of R5.

## Options considered
- A: Check R5 on the entity's route segments; verify AC5 with entities whose route is `/docs` (`entities/Doc.ts`,
  `@collection docs`, or a `docs` schema folder).
- B: Allow lowercase entity file names when they collide with a reserved path, to report the reserved path instead.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`entities/Doc.ts` fails with `entities/Doc.ts: route /docs uses /docs, which is reserved for the API docs`. Spec 0033
AC5 should say `entities/Doc.ts`; an `update-spec` can align the wording.
