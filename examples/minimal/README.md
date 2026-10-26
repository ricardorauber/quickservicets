# Minimal examples

Every native feature ships one folder here, named after its key (`examples/minimal/<key>`), with the smallest project that proves it end to end and shows each way to customize it. The examples of plugin packages are named `plugin-<key>`, after their `packages/plugin-<key>` package; no other folder is allowed.

Each folder is a workspace:

- `package.json` names the workspace and depends on `@quickservicets/core` and `@quickservicets/cli` with `workspace:*`;
- `tsconfig.json` extends the repository's `tsconfig.base.json`;
- `quickservicets.config.ts` enables the feature (or relies on its default when the feature is enabled by default);
- `tests/` holds the tests, which start the project on the memory adapter with `startTestService` from `@quickservicets/cli/testing`.

The `README.md` of a native's example has these second-level headings, in this order, each with at least one code sample or a line starting with `Not applicable:` that says why:

1. `Level 0: enable`
2. `Level 1: options and environment`
3. `Level 2: tags`
4. `Level 3: per request`
5. `Level 4: hooks and events`
6. `Level 5: override files`
7. `Level 6: replace the implementation`
8. `Level 7: eject`

`scripts/minimal-examples.test.ts` checks these rules for every registered native and reports every problem in one failure. The tests run from the repository root with `bun test`, or from the folder with `bun run test`.
