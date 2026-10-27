# 0073 - A required function is decided after the tenant is resolved

- Date: 2026-10-27
- Spec: 0250-auth-customization-example-and-guide
- Status: accepted

## Context
Spec 0246 R4 runs the `@auth` and `@roles` checks in the auth middleware right after authentication (order 100).
Spec 0250 R2 lets `auth.required` be a function `({ req, tenant }) => boolean`, so a tenant attribute decides whether
its API is private, and AC2 needs `tenant.attributes`. The tenant is resolved by the `tenancy` middleware at order
200, after authentication, because tenancy checks the tenant the credentials carry; at order 100 the function would
never see the tenant.

## Options considered
- A: Keep every tag-based check at order 100, and evaluate the `required` function, only for routes without an
  `@auth` tag, in a second auth middleware at order 250 (after tenancy at 200, before the security limits at 1000 and
  every hook), registered only when `required` is a function — accurate tenants, no cost otherwise.
- B: Move all checks after tenancy: an anonymous request to a protected route would then get tenancy's 400 or 404
  before the 401, and every check would run later than spec 0246 says.
- C: Evaluate the function at order 100 without the tenant: breaks spec 0250 R2 and AC2.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
With a `required` function, the routes without `@auth` are decided at order 250, with `req.tenant` set; the OpenAPI
document marks them as needing a user, since some tenants require one. Tagged routes and the boolean form keep the
checks of spec 0246 at order 100.
