# 0059 - The flags example's stand-in for authentication is a feature middleware

- Date: 2026-10-26
- Spec: 0216-flags-example-and-guide
- Status: accepted

## Context
Spec 0216 R1 asks for "a demo pre-hook that sets `req.user` from the `x-user-id` header", and AC2 for `POST /checkout`
(tagged `@flag checkout-v2`) to answer 200 for `u1`. Spec 0213 R2 decides a route's gate "before any hook or handler
runs", so a pre-hook sets the user too late: the gate sees an anonymous caller and answers 404 to `u1`. Project
middlewares of the config run after the features' middlewares, so they are also too late.

## Options considered
- A: Write the stand-in as a project feature `features/demo-user/` with a handler middleware ordered before the flags
  native's — as an authentication feature sets `req.user` — clearly marked as a demo; AC2 holds and 0213 R2 stays.
- B: Keep the pre-hook and decide gates after the pre-hooks — breaks 0213 R2 and AC1 (a gated route's pre-hooks would
  run for callers who must not see it).
- C: Keep the pre-hook and let `u1` get 404 — fails AC2.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
The example has `features/demo-user/index.ts` and enables it with `"demo-user": {}`; the guide explains that the user
must be set before flags are read, as an authentication feature does.
