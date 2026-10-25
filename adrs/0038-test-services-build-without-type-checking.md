# 0038 - Test services build without type-checking

- Date: 2026-10-25
- Spec: 0152-test-service-harness
- Status: accepted

## Context
Spec 0152 asks `startTestService` to build a temporary project and to reject "with the build output" when "a file with
a type error" is among its files (R3, AC3). `quickservice build` parses entities with the TypeScript compiler and fails
on errors it finds there (an unsupported field type, a syntax error), but it does not type-check endpoints, hooks or
features: Bun runs TypeScript without checking types. Type-checking a small project against the framework's types takes
about five seconds, and the harness is meant to be started by many tests.

## Options considered
- A: Build only: errors the build reports, such as an entity field of an unknown type, reject with the build output,
  and type checking stays with `bun run typecheck` and the editor. Each test service starts in well under a second.
- B: Run the TypeScript compiler over every temporary project after the build — catches every type error, but adds
  seconds to each test service and makes feature test suites slow.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`startTestService` runs `build` and rejects with `Build failed:` and the build's message; its test uses an entity field
of an unknown type as the file with a type error. A later spec can add an opt-in type check if feature tests need it.
