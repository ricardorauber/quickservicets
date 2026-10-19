# 0009 - Field selection under nested populate paths does not add `id` automatically

- Date: 2026-10-19
- Spec: 0093-field-selection-under-nested-populate
- Status: accepted

## Context
Spec 0093 R2 says `fields` "SHALL keep returning only the selected paths plus `id`". AC1 expects
`GET /users?populate=organization.country&fields=organization.name` to return users with `id` and
`organization: { id, name }`, and AC2 expects profiles with `id` and `slug`. The generated list and read routes have
never added `id` to a client selection: spec 0036 AC2 requires that `GET /users?fields=name,address.city` returns
"only `name` and `address.city`; `id` is absent". The tests and the field selection and populate guides follow
spec 0036. The two specs contradict each other, and the scope of 0093 is only to count every prefix of a populate
path as populated.

## Options considered
- A: Keep the spec 0036 behavior. `fields` returns exactly the selected paths, so the AC1 request returns
  `organization: { name }`, without `country` and without ids. This changes nothing outside the scope of 0093, and
  clients that want ids select them (`fields=id,organization.id,organization.name`). The literal `id` parts of 0093
  AC1 and AC2 are not met.
- B: Always add `id` to every record and to every populated record when `fields` is given. This meets 0093 AC1 and
  AC2 word for word, but it changes every field selection response, breaks spec 0036 AC2, its tests and the docs,
  and goes beyond the scope of 0093.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
Every prefix of a populate path counts as populated for `fields` and `exclude`; the selected paths are returned
exactly as listed, without an automatic `id`. The populate guide shows the response without ids. AC1 and AC2 of
spec 0093 stay unchecked because of their `id` parts. Spec 0093 should be updated with `update-spec` to drop
"plus `id`" from R2, AC1 and AC2, or a new spec should change the `id` rule for every selection.
