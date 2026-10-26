# flags

The smallest project that shows the `flags` native: rules in the config turn `checkout-v2` on for one user and 10% of the others, and `dark-mode` on for everyone; `GET /settings` answers the caller's flags from `req.flags.all()`.

```bash
bun run test
```

## Level 0: enable

Turn the native on; `req.flags` is then set on every request:

```ts
export default defineConfig({ database: memoryAdapter(), flags: {} });
```

## Level 1: options and environment

Rules turn flags on for users, tenants or a percentage of users, and every option has a `QS_*` variable:

```ts
flags: { rules: { "checkout-v2": { users: ["u1"], percentage: 10 }, "dark-mode": true } }
```

```bash
QS_FLAGS_ENABLED=false bun .generated/server.ts
```

## Level 2: tags

`@flag checkout-v2` hides an endpoint, or every route of an entity, behind a flag: callers it is off for get 404:

```ts
/** @flag checkout-v2 */
export default () => ({ ordered: true });
```

## Level 3: per request

A rule can be a function of the request, its user and tenant, returning a boolean synchronously:

```ts
flags: { rules: { "pro-reports": ({ tenant }) => (tenant as { plan?: string } | undefined)?.plan === "pro" } }
```

## Level 4: hooks and events

`onEvaluate` observes each new evaluation, for example to log exposures for an experiment:

```ts
flags: { onEvaluate: ({ name, on, reason, user }) => console.info("flag", name, on, reason, user) }
```

## Level 5: override files

With `source: "database"`, a project `entities/FeatureFlag.ts` replaces the table, keeping its fields and adding others; `quickservice flags set` changes rows:

```ts
/** @internal */
export type FeatureFlag = {
  /** @unique */
  name: string;
  /** @default true */
  enabled: boolean;
  users?: string[];
  tenants?: string[];
  percentage?: number;
  description?: string;
  owner?: string;
};
```

## Level 6: replace the implementation

`provider` replaces the evaluation, like a client of a flag service:

```ts
flags: { provider: { isOn: (name) => name === "beta", all: () => ({ beta: true }) } }
```

## Level 7: eject

Copy the native into the project as a `features/flags/` project feature that replaces it:

```bash
quickservice eject flags
```
