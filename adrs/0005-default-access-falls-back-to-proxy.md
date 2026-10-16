# 0005 - File access defaults to proxy when the storage has no public URL

- Date: 2026-10-16
- Spec: 0048-file-access
- Status: accepted

## Context
Spec 0048 makes `direct` the default access mode and fails the build when a `direct` entity's storage has no
`publicUrl`. With the built-in `File` and `Media` entities (spec 0044) and the default local storage without a public
base URL (ADR 0004), every project would fail to build.

## Options considered
- A: Without `@access` or `files.access`, use `direct` when the storage offers `publicUrl` and `proxy` otherwise; an
  explicit `direct` on a storage without `publicUrl` still fails the build.
- B: Keep `direct` as the only default and require every project to configure a public base URL or an access mode.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
Projects without storage configuration serve files through `GET /<route>/[id]/file`. Spec 0048 R1/R2 should be read
accordingly; an `update-spec` can align the wording.
