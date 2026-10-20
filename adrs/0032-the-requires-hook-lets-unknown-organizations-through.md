# 0032 - The requires hook lets requests for unknown organizations through to the endpoint

- Date: 2026-10-20
- Spec: 0127-identity-example-features
- Status: accepted

## Context
Spec 0127 has the `@requires` pre-hook answer only 401 `Missing x-user-id header` or 403 `Missing permission
<module>:<action>`, and the stats endpoint it protects answer 404 `Organization not found` for an unknown
organization. Pre-hooks run before the handler, and nobody holds a permission in an organization that does not exist,
so a hook that only grants or denies would answer 403 and the 404 could never be reached.

## Options considered
- A: When the organization does not exist, the hook lets the request through and the endpoint answers its 404 —
  both requirements hold; one extra existence query per request, and with a caller header an unknown id is
  distinguishable from a forbidden one (acceptable: the header is a demo stand-in for authentication anyway).
- B: The hook answers 403 for unknown organizations — hides whether an organization exists, but the endpoint's 404 is
  unreachable, contradicting the spec.
- C: The hook answers 404 itself — the 404 is reachable, but the hook gains an outcome the spec does not list and
  every endpoint using it inherits that message.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`hooks/requires.ts` checks first that the `x-user-id` header is present (401), then whether the organization exists
(and returns when it does not), then the permissions (403). Its doc comment says so.
