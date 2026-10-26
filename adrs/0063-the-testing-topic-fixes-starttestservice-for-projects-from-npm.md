# 0063 - The testing topic fixes `startTestService` for projects created from npm

- Date: 2026-10-26
- Spec: 0833-agent-guide-sources-and-agents-md
- Status: accepted

## Context
Spec 0833 R1 asks for a `testing` agent topic built on `startTestService`, and the topics must work for someone using
the published packages outside the repository. Following the topic in a project created with
`bunx quickservicets init` failed: `startTestService` linked the temporary project to `packages/core` and
`packages/cli` four folders above its own file, a path that exists only in the repository. In a project's
`node_modules` the links pointed nowhere and the build of the test service could not find `@quickservicets/core`.

## Options considered
- A: Resolve the two packages from where the CLI runs (`@quickservicets/core` through the module resolver, the CLI from
  its own folder) — one small change, works in the repository and from npm, and the topic stays as the spec asks.
- B: Leave `startTestService` as it is and write the testing topic around `createApp` and `.generated/` — avoids touching
  the CLI, but contradicts the spec, which names `startTestService`, and leaves a broken public API.
- C: Write the topic as the spec asks and leave the bug — the topic would fail for every reader using npm.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`packages/cli/src/testing/service.ts` links the packages it runs with instead of repository paths. The fix is listed
under "Fixed" in the changelog. It was checked with the packed tarballs in a project outside the repository.
