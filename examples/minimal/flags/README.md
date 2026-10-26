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

Not applicable: no option is resolved per request yet.

## Level 4: hooks and events

Not applicable: the native declares no hook yet.

## Level 5: override files

Not applicable: the native contributes no entities, routes or jobs yet.

## Level 6: replace the implementation

Not applicable: flags are evaluated from the config's rules only so far.

## Level 7: eject

Copy the native into the project as a `features/flags/` project feature that replaces it:

```bash
quickservice eject flags
```
