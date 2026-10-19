# 0028 - The resolved `jobs` config keeps durations and sizes as written

- Date: 2026-10-19
- Spec: 0105-job-runs-and-config
- Status: accepted

## Context
Spec 0105 R4 lists the `jobs` defaults as `"5m"`, `"30s"`, `"64KB"` and so on, and AC4 checks that "the resolved
defaults are the R4 values". Later specs show these values in messages (`Timed out after <timeout>`,
`Result larger than <limit> was not stored`). Other resolved keys, such as `files.maxSize`, are converted to numbers.

## Options considered
- A: Validate durations and sizes in `loadConfig`/`resolveConfig` and keep them as written (`"5m"`, `"64KB"`); code
  converts them with `parseDuration`/`parseSize` when it needs numbers — messages show what the user wrote.
- B: Convert them to milliseconds and bytes — numbers ready to use, but messages would need the written form kept
  elsewhere, and the resolved defaults would not read as the R4 values.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`ResolvedConfig.jobs` holds `enabled`, `timeZone`, `timeout`, `retries`, `retryDelay`, `retention`, `shutdownGrace` and
`limits: { result, logLines }` with the written values; `jobSettings(options, config.jobs)` merges a job's options
over them.
