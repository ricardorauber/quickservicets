# 0026 - Unknown job options fail the build

- Date: 2026-10-19
- Spec: 0103-job-declarations
- Status: accepted

## Context
Spec 0103 R3 lists the job options (`retries`, `retryDelay`, `timeout`, `retention`, `timeZone`, `overlap`) and R5
fails the build for "an option of the wrong type", but does not say what happens to a key that is not an option at
all, such as the typo `retry`. (Dates without an offset are covered by ADR 0024.)

## Options considered
- A: Fail the build with `<file>: unknown option "<key>"` — typos surface at build time instead of a job silently
  running with the defaults.
- B: Ignore unknown keys — more lenient, but a misspelled `retries` or `timeout` is silently lost.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
The build rejects job options with keys other than the six of R3. The Jobs guide (spec 0111) can mention it.
