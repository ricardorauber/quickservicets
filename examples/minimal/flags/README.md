# flags

The smallest project that shows the `flags` native: rules in the config turn `checkout-v2` on for one user and 10% of the others and `dark-mode` on for everyone; `GET /settings` answers the caller's flags, `POST /checkout` hides behind `checkout-v2`, and a job reads flags outside a request. The `demo-user` feature is a stand-in for authentication that trusts the `x-user-id` header.

```bash
bun run test
```

The feature flags guide (`docs/src/content/docs/guides/feature-flags.md`, on the site at `/guides/feature-flags/`) explains every piece.

## Level 0: enable

Turn the native on; `req.flags` is then set on every request:

```ts
export default defineConfig({ database: memoryAdapter(), flags: {} });
```

## Level 1: options and environment

Rules turn flags on for users, tenants or a percentage of users, and every option and rule has a `QS_*` variable:

```ts
flags: { rules: { "checkout-v2": { users: ["u1"], percentage: 10 }, "dark-mode": true } }
```

```bash
QS_FLAGS_RULES_CHECKOUT_V2=false bun .generated/server.ts
```

## Level 2: tags

`@flag checkout-v2` hides an endpoint, or every route of an entity, behind a flag; under a global `gate`, `@flag off` keeps one route open:

```ts
/** @flag checkout-v2 */
export default () => ({ ordered: true });
```

```ts
// flags: { gate: "beta" } hides every route from callers beta is off for, except:
/** @flag off */
export default () => ({ status: "up" });
```

## Level 3: per request

A rule can be a function of the request, its user and tenant, returning a boolean synchronously:

```ts
flags: { rules: { "pro-reports": ({ tenant }) => (tenant as { plan?: string } | undefined)?.plan === "pro" } }
```

## Level 4: hooks and events

`onEvaluate` observes each new evaluation, for example to log exposures for an experiment:

```ts
flags: { onEvaluate: ({ name, on, reason, user }) => console.info("flag exposure", name, on, reason, user) }
```

## Level 5: override files

With `source: "database"`, a project `entities/FeatureFlag.ts` replaces the table, keeping its fields and adding others; `quickservice flags set` changes rows without a deploy:

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

```bash
quickservice flags set checkout-v2 --percentage 50
```

## Level 6: replace the implementation

`provider` replaces the evaluation, like one backed by a JSON file that operations edit:

```ts
const file = JSON.parse(readFileSync("flags.json", "utf8")) as Record<string, boolean>;
flags: { provider: { isOn: (name) => file[name] === true, all: () => ({ ...file }) } }
```

## Level 7: eject

Copy the native into the project as a `features/flags/` project feature that replaces it:

```bash
quickservice eject flags
```
