# 0008 - Generated repositories type their create and update inputs

- Date: 2026-10-16
- Spec: 0068-enum-types-and-openapi
- Status: accepted

## Context
Spec 0068 R1 types enum fields "in entity types, create/update input types and typed repositories", and AC1 expects
`repos.posts.create({ status: "draft" })` to fail to type-check. The generated repositories took `data: unknown`, so
no create or update input types existed.

## Options considered
- A: Generate `<Entity>Create` and `<Entity>Update` types (writable fields; Create requires the non-optional fields
  without `@default`) and type `create`, `replace` and `update` of the generated repositories with them.
- B: Type enum fields only in entity types and keep inputs `unknown`; AC1 would need an update-spec.

## Decision
The user chose A ("Generate input types").

## Consequences
`Repository` gains input type parameters that default to `unknown`, and `.generated/types.ts` emits the input types.
Custom endpoints and hooks get typed repository inputs for every field. Spec 0068 should mention the input types it
relies on; an `update-spec` can align the wording.
