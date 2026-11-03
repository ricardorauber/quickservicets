# 0093 - The flags native registers its preparing middleware when a provider may prepare

- Date: 2026-11-03
- Spec: 0295-flag-provider-preparation
- Status: accepted

## Context
Spec 0295 R2 says the flags native registers an order-300 `handler` middleware that awaits the provider's `prepare` when the active provider declares one, and no such middleware otherwise. Providers are set either by `flags.provider` in the config, known at the native's setup, or by another feature calling `ctx.feature("flags").setProvider(...)` during its own setup, which runs after the flags native's setup. A feature can only add middlewares during its own setup (spec 0146), so the native cannot add one when a later feature sets a preparing provider.

## Options considered
- A: Register the middleware when the configured provider declares `prepare`, or when an enabled feature lists `flags` in `requires`, `after` or `enables` (the features that may call `setProvider`); it passes straight through while the active provider has no `prepare`. A service on the config or database source alone has no such middleware.
- B: Let `setProvider` add middlewares for the calling feature; it needs a new lifecycle mechanism in the core.
- C: Always register the middleware; it contradicts R2 and AC5.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
- A service with a feature depending on `flags` has one more handler middleware, which only checks whether the provider prepares while it does not.
- The `@flag` gate is checked by that middleware when the provider prepares, and by the early flags middleware otherwise.
