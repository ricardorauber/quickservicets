# 0055 - The events a change stream offers are an option the `@changes` tag sets

- Date: 2026-10-26
- Spec: 0208-sse-customization-example-and-guide
- Status: accepted

## Context
Spec 0208 R2 lets `@changes events=created,deleted` limit the events one entity's change stream offers. Feature tags
(spec 0144) can only set options of the feature, so `events` must be an option for the tag to set it.

## Options considered
- A: Add `sse.events` (the created, updated and deleted events by default, `QS_REALTIME_SSE_EVENTS`), the global list
  of offered events, and scope the tag to `sse` with the option `events` — the tag's value wins for its entity, as
  every tag option does (spec 0144 R6).
- B: A tag-only option outside the feature's options — not supported by the tag contract.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`realtime.sse.events` appears on the reference page; a stream asked for events its entity does not offer answers 400
naming `events`.
