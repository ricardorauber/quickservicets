# connections

The smallest project that shows the `connections` native: PostgreSQL with a budget of 100 connections shared by up to 10 instances.

## Level 0: enable

The native is enabled by default; building for a function target gives small, lazy pools:

```bash
bun run quickservicets build --target lambda
```

## Level 1: options and environment

```ts
connections: { max: 5, budget: 100, instances: 10 },
```

```bash
QS_CONNECTIONS_MAX=3 bun run dev
```

## Level 2: tags

Not applicable: pools belong to the process, not to entities, fields or routes.

## Level 3: per request

Not applicable: pools belong to the process, not to requests.

## Level 4: hooks and events

Not applicable: the native has no hooks yet.

## Level 5: override files

Not applicable: pools belong to the process, so there is no file to override.

## Level 6: replace the implementation

Not applicable: the drivers cannot be replaced yet.

## Level 7: eject

```bash
bun run quickservicets eject connections
```
