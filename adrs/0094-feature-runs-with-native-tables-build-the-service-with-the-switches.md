# 0094 - Feature runs whose natives add entities build the service with the switches and create their tables

- Date: 2026-11-03
- Spec: 0303-benchmark-webhooks
- Status: accepted

## Context
Spec 0303 R1 says `--features webhooks=on` sets `QS_WEBHOOKS_ENABLED=true`, and R3 asks for the result files of one run. The benchmark image runs `quickservicets build` with no feature on, and the compose database gets only `schema/schema.sql`. With `QS_WEBHOOKS_ENABLED=true` the service turns on `queues`, whose setup fails with `The queues native needs the QueueMessage entity; run quickservicets build after enabling it`, so neither `webhooks=on` nor `events=on,queues=on` can run as the spec asks.

## Options considered
- A: A switch with native tables (`queues`, also when `webhooks` turns it on) builds the image with the run's `QS_*` variables (`--build-arg QS_BUILD_ENV`), and after the schema reset the runner creates the tables of the models a feature owns, from a host build with the same variables (`benchmarks/native-tables.ts`); the run records the step as `features.plan.nativeTables`. Every other switch runs as before.
- B: Commit a migration of the queue and webhook tables to the benchmark project; it would add tables to every run, the baseline included, and change what the other stacks are compared with.
- C: Leave `webhooks=on` unrunnable and commit no result; it fails R3.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
- `features.ts` gains `SwitchExtras.nativeTables` and `plan.nativeTables`; the extras of natives a switch turns on through `enables` apply too.
- The benchmark Dockerfile takes `ARG QS_BUILD_ENV`, empty for every other run, so the baseline image is unchanged.
- `benchmarks/native-tables.ts` builds the benchmark service on the host, which rewrites its ignored `.generated/` folder.
