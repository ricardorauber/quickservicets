# 0004 - A default local storage is used when the config declares none

- Date: 2026-10-16
- Spec: 0045-storage-adapters-local
- Status: accepted

## Context
Spec 0045 R2 makes `loadConfig` fail when file entities exist and `storage.default` is missing. Spec 0044 makes the
built-in `File` and `Media` entities exist in every project, so read literally every config without `storage` would
fail — including configs written before file support and the ones `init` creates.

## Options considered
- A: When `storage` is absent, use `localStorage({ dir: "uploads" })` under the project root as `default`; when
  `storage` is present it must contain `default`, otherwise `loadConfig` fails naming `storage.default`.
- B: Require `storage.default` only when a file entity is referenced or declared by the project, checked at build time.
- C: Always require `storage.default`.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
Projects work without storage configuration (files go to `<project>/uploads`); an incomplete `storage` map still
fails with `storage.default`. Spec 0045 R2/AC2 should be read accordingly; an `update-spec` can align the wording.
