# 0102 - Trigger checkpoints come with the feature that polls partitions

- Date: 2026-11-05
- Spec: 0326-trigger-polling-in-servers
- Status: accepted

## Context
Spec 0326 R4 stores partition leases and positions in the shared system entity `TriggerCheckpoint`, "added when a polling source is registered". Sources are registered at runtime, in the setups of other features, while the build and `migration add` decide the model synchronously from the config, so the native cannot know at build time whether a polling source with partitions will be registered.

## Options considered
- A: Export `triggerCheckpointEntity`; the feature that registers a source reading partitions adds it to its own `entities`, as external queue brokers add `queueDedupeEntity`. Several features contributing the same shared system entity keep one table. A poll that uses `ctx.checkpoints` without the entity fails with a message naming the fix. The table exists exactly while such a feature is enabled.
- B: Add the entity whenever `triggers` is enabled with `poll` on. Simple, but every project with triggers gets a table it may never use, against the minimal-service rule.
- C: Run the feature setups at build time to find polling sources. Heavy, asynchronous where model parsing is synchronous, and setups may need the environment.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
- `triggerCheckpointEntity` and `checkpointStore` are exported from `@quickservicets/core`.
- The contributed-entities step keeps one copy of a system entity that several features contribute with the same key and table.
- Cloud source packages that read streams (spec 0656 and later) list `triggerCheckpointEntity` in their `entities`.
