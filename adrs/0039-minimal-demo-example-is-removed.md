# 0039 - The minimal demo example is removed

- Date: 2026-10-25
- Spec: 0158-minimal-feature-examples-check
- Status: accepted

## Context
Spec 0152 added `examples/minimal/demo`, a workspace with one test that showed the test harness running from the root
suite (0152 AC4). Spec 0158 R6 makes the minimal examples check fail for every folder of `examples/minimal` whose name
is neither a native key nor `plugin-<key>` of an existing package. `demo` is neither, so the check cannot pass while the
folder exists, and the roadmap gives the later spec ownership of changes across specs.

## Options considered
- A: Remove `examples/minimal/demo`; the harness test checks that every minimal folder is a workspace depending on the
  workspace packages and runs the first one's tests from the root, which the events example does from spec 0161 on. The
  harness itself stays covered by its own tests in `packages/cli/src/testing`.
- B: Allow `demo` as an exception in the check — keeps spec 0152's folder, but breaks spec 0158 R6 and keeps an example
  that shows no feature.
- C: Rename `demo` — any other name fails R6 the same way.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`examples/minimal/demo` and its lockfile entry are gone, and the minimal examples README describes the native layout.
Spec 0152 AC4 is now covered by the workspace rule and by the native examples; spec 0152 needs no text change beyond
noting that its demo folder was superseded by spec 0158.
