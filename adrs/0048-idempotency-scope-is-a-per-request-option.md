# 0048 - The idempotency scope is a per-request option, not a hook

- Date: 2026-10-25
- Spec: 0196-idempotency-customization-example-and-guide
- Status: accepted

## Context
Spec 0196 R3 declares the option `scope` as `hook()` (spec 0156), receiving `{ req, user, tenant }` and returning a
text. Spec 0156 R4 makes `defineFeature` throw for a `hook()` option not named `before<Step>`, `after<Step>` or
`on<Event>`, and hooks receive `(value, ctx)` and pass a value on, which is not what the scope needs.

## Options considered
- A: Declare `scope` as `string().optional().perRequest()`: a per-request function already receives
  `{ req, user, tenant }` (spec 0135 R7) and returns a text, which is exactly the behavior R3 describes, and it keeps
  the hook naming rule.
- B: Name the hook `onScope` or `beforeScope`: keeps `hook()` but bends the hook semantics (the value would be the
  default scope) and the option name the spec and docs use.
- C: Relax the hook naming rule for this option: an exception to a rule every feature follows.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`idempotency.scope` is a per-request option whose function returns the text that replaces the user part of a key's
scope; the reference lists it as per request. The spec could be updated to describe it that way.
