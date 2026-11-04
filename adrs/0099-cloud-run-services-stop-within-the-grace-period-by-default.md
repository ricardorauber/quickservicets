# 0099 - Cloud Run services stop within the grace period by default

- Date: 2026-11-04
- Spec: 0316-cloud-run-target
- Status: accepted

## Context
Spec 0316 R4 asks the `cloud-run` service to finish within Cloud Run's 10-second grace period after SIGTERM, and the build to warn when `lifecycle.stopTimeout` plus `health.drainDelay` exceeds 9 seconds. The core's defaults are a 10-second stop time limit and, in production, a 5-second drain delay: 15 seconds, so every Cloud Run build of an unconfigured project would warn and every container could be killed mid-shutdown, while AC4 treats the warning as the result of a longer configured limit.

## Options considered
- A: On the `cloud-run` target, a project that sets no stop time limit stops within 8 seconds, and the health routes drain for 1 second when the project sets no drain delay; the warning appears only when the project's own values (or these defaults) exceed 9 seconds. Unconfigured services fit the grace period and build without warnings.
- B: Keep the core defaults and warn on every Cloud Run build. Every project must lower two values by hand to deploy safely.
- C: Change the core defaults for every target. Changes the shutdown of every existing server deployment.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
- `cloudRunConfig(config)` applies `CLOUD_RUN_STOP_TIMEOUT` (8 seconds) and `CLOUD_RUN_DRAIN_DELAY` (1 second) where unset; `runCloudRun` uses it, and the build's warning reads the same values.
- Other targets keep the core defaults.
