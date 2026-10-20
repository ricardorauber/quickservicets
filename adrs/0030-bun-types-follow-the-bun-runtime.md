# 0030 - The Bun type definitions follow the Bun runtime version

- Date: 2026-10-20
- Spec: 0128-repository-typecheck
- Status: accepted

## Context
Spec 0128 asks for a repository-wide `tsc --noEmit` that exits 0 without changing behavior. The repository runs on
Bun 1.4.2 but pins `@types/bun` 1.2.21, whose `beforeAll` takes no timeout. `docs/tests/site.test.ts` passes one (the
docs build takes minutes), which the runtime honors but the old definitions reject.

## Options considered
- A: Update `@types/bun` to 1.4.2, the version of the runtime — the definitions describe the APIs the code really
  runs on; the lockfile changes and newer definitions may report new errors (none did).
- B: Keep 1.2.21 and cast `beforeAll` in that test — no dependency change, but a cast that hides a real API, and the
  next newer API used hits the same wall.
- C: Drop the hook timeout and raise the default timeout of the file — changes how that test behaves.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`package.json` and `bun.lock` pin `@types/bun` 1.4.2. Updating Bun should update `@types/bun` to the same version.
