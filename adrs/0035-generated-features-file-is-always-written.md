# 0035 - The generated features file is always written, and the build file list test names it

- Date: 2026-10-25
- Spec: 0138-project-features
- Status: accepted

## Context
Spec 0138 asks the build to write `.generated/features.ts` for every project, empty when there is no `features/`
folder (R5, R6), so the generated server can import it unconditionally. It also asks that the existing build tests
pass unchanged (AC6). One existing test, "builds are deterministic", lists the exact files of `.generated/`, so it
cannot pass unchanged once a new generated file exists.

## Options considered
- A: Always write `.generated/features.ts` as R5 and R6 say, and add it to the file list of that one test; every
  other existing build test passes unchanged. The generated server imports the file without conditions.
- B: Write the file only when the project has features, keeping the test unchanged — contradicts R6 ("an empty
  `.generated/features.ts`") and makes the generated server's imports depend on the project.
- C: Keep the file but leave the test failing — not acceptable.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`build.test.ts` lists `features.ts` among the generated files. The build summary line stays as before for projects
without features, and `BuildSummary.features` and `overrides` are optional so existing code that builds summaries
keeps compiling.
