# 0031 - Organization stats count the distinct profiles its memberships and teams carry

- Date: 2026-10-20
- Spec: 0127-identity-example-features
- Status: accepted

## Context
Spec 0127 asks `GET /organizations/[orgId]/stats` for `{ members, activeMembers, teams, activeTeams, profiles }` "for
the organization", computed with `aggregate()`, one query per counted entity. Memberships and teams belong to an
organization, but profiles do not: they are shared by every organization, and only memberships and teams point at
them. The spec does not say which profiles `profiles` counts.

## Options considered
- A: The distinct profiles the organization's memberships and teams carry — the number that describes the
  organization; it needs the profile ids of those memberships and teams (two `select("profiles")` queries) before one
  `aggregate()` on profiles.
- B: Every profile in the database — one `aggregate()` and nothing else, but the same number for every organization.
- C: The number of profile assignments (the sum of the `profiles` array sizes) — counts a profile once per holder and
  cannot be computed by `aggregate()`, which has no array-size expression.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
The endpoint runs one `aggregate()` on memberships, one on teams and one on profiles (skipped when there are no profile
ids), plus the two queries that collect the profile ids. Its `Stats` type documents what `profiles` counts.
