# 0090 - The `@webhooks` tag's options live under the `webhooks.entity` option section

- Date: 2026-11-03
- Spec: 0284-webhooks-feature-and-subscriptions
- Status: accepted

## Context
Spec 0284 R3 gives the entity tag `@webhooks` the shorthand `events`, a list of the write operations `created`, `updated` and `deleted`. Spec 0292 R2 adds the tag option `fields`. Feature tags (spec 0144) can only set options of the feature, either top-level ones or, with `scope`, the keys of one nested object. The top-level option `events` of spec 0284 R2 already exists with another meaning: a list of event patterns such as `invoice.*`. A tag writing `@webhooks created` into that option would replace the project's patterns with an operation name.

## Options considered
- A: An option section `entity` (`object({ events, fields? })`, `events` defaulting to all three operations) as the tag's `scope`, as the `queues` native does with `publish` for `@publish`. The tag reads exactly as the spec writes it, and `webhooks.entity.events` also sets the project-wide default of tagged entities.
- B: A tag that sets no feature option and parses its own text. It needs a new tag mechanism in the core, for one native.
- C: Rename the top-level `events` option. It breaks the option names the spec fixes.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
- `webhooks.entity.events` (variable `QS_WEBHOOKS_ENTITY_EVENTS`) is an extra option beside those of spec 0284 R2, and `webhooks.entity.fields` arrives with spec 0292 R2.
- `@webhooks`, `@webhooks created,updated` and `@webhooks off` behave as the spec says.
