# Minimal examples

Each folder here is a workspace that proves one feature end to end with the smallest project that shows it:

- `package.json` names the workspace and depends on `@quickservice/core` and `@quickservice/cli` with `workspace:*`;
- `tsconfig.json` extends the repository's `tsconfig.base.json`;
- `tests/` holds the tests, which start the project with `startTestService` from `@quickservice/cli/testing`.

The tests run from the repository root with `bun test`, or from the folder with `bun run test`.
