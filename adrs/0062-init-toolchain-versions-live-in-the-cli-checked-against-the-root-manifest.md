# 0062 - The `init` toolchain versions live in the CLI, checked against the root manifest

- Date: 2026-10-26
- Spec: 0841-type-checking-in-new-projects
- Status: accepted

## Context
Spec 0841 R1 asks `init` to add `@types/bun` and `typescript` at the versions the repository uses, "read from the root
`package.json` at build time of the CLI, so they stay in step". The CLI has no build step: it is published as its
TypeScript source, and the repository's root `package.json` is not part of its tarball, so the published CLI cannot read
that file when it runs. Bun macros, which would inline a value at transpile time, are disabled for code inside
`node_modules`, so they do not work in the published package either.

## Options considered
- A: Keep the two versions in a small module of the CLI (`packages/cli/src/init/toolchain.ts`) and have a unit test
  compare the `package.json` that `init` writes with the root manifest — the published CLI works anywhere, inside the
  repository the versions are the same, and the test suite fails as soon as the root versions move without the module.
- B: Have the release script rewrite a versions file inside the CLI tarball at pack time from the root manifest, and
  read the root manifest at run time inside the repository — reads the root file literally, but adds two code paths
  and a tarball edit that only `release:check` exercises.
- C: Read the root `package.json` at run time with a relative path — works only inside the repository; a project
  created from npm would get no versions.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`packages/cli/src/init/toolchain.ts` holds the `@types/bun` and `typescript` versions; the init test reads the root
`package.json` and fails when they differ. Bumping either tool in the root manifest means updating that module in the
same change. The spec's wording ("read ... at build time") could be updated to "kept in step by a test" with
`update-spec`.
