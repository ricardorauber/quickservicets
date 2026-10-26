---
title: Feature flags
description: Turn features on and off per user, per tenant or for a percentage of users, read them synchronously in endpoints, hooks, jobs and queue consumers, hide routes behind them, and change them at runtime.
sidebar:
  order: 56
---

A new checkout is ready, but it should reach two internal testers first, then 10% of the customers, and be switched off in seconds if something breaks. The `flags` native turns features on and off per user, per tenant or for a percentage of users, with rules in the config or rows in the database, and the code asks `req.flags.on("checkout-v2")`. The options, variables, tag, hook, commands and provider are listed on the [flags reference page](/reference/features/flags/).

The samples come from the example project `examples/minimal/flags`.

## Enabling flags

```ts title="quickservicets.config.ts"
import { defineConfig, memoryAdapter } from "@quickservicets/core";

export default defineConfig({
  database: memoryAdapter(),
  "demo-user": {},
  flags: {
    rules: {
      "checkout-v2": { users: ["u1"], percentage: 10 },
      "dark-mode": true,
    },
  },
});
```

With `flags: {}` every request gets `req.flags`. Flag names use lowercase letters, digits, `_` and `-`; any other name fails at startup.

## Rules and their order

A rule is `true` (on for everyone), `false` (off for everyone), or an object with `users`, `tenants`, `percentage`, `enabled` and `description`. A flag is evaluated for the request's user id and tenant id, in this order:

1. `enabled: false` turns it off.
2. A user listed in `users` gets it on.
3. A tenant listed in `tenants` gets it on.
4. A user (or a tenant, without a user) inside `percentage` gets it on.
5. A rule listing none of `users`, `tenants` and `percentage` is on for everyone; otherwise the flag is off.

## Percentage rollouts

The percentage bucket is the first four bytes of SHA-256 of `<flag>:<user id>` (the tenant id without a user) modulo 100. It needs no storage and gives one user the same answer in every process and replica, and moving from 10 to 20 keeps everyone who already had it. Anonymous requests have no bucket, so a percentage never turns a flag on for them.

## `req.flags`

```ts title="endpoints/settings/get.ts"
import type { Repositories, ServiceRequest } from "@quickservicets/core";

/** The flags of the caller, for the client to show or hide features. */
export default (_repos: Repositories, req: ServiceRequest) => req.flags!.all();
```

`req.flags.on(name)`, `off(name)` and `all()` answer synchronously, from memory, with the user and tenant the request has when they are called; each name is evaluated once per request. With rules in the config, `on` accepts only their names, checked by TypeScript; an unknown name is off and logs one `flags.unknown` warning per process. `req.user` must be set before the flags are read: here a stand-in feature does it, as an authentication feature would.

```ts title="features/demo-user/index.ts"
import { defineFeature } from "@quickservicets/core";

/**
 * A stand-in for authentication, for this demo only: it trusts the `x-user-id` header and runs before the flags are
 * read, as an authentication feature does. A real project sets `req.user` from a verified token or session instead.
 */
export default defineFeature({
  key: "demo-user",
  middleware: [
    {
      stage: "handler",
      order: -60_000,
      run: (req, _res, next) => {
        const id = req.headers.get("x-user-id");
        if (id) req.user = { id };
        return next();
      },
    },
  ],
});
```

## `@flag` and the 404 answer

```ts title="endpoints/checkout/post.ts"
/**
 * The new checkout, answered only to the callers `checkout-v2` is on for; the others get 404.
 * @flag checkout-v2
 */
export default () => ({ ordered: true });
```

While the flag is off for the caller, the route answers `404 Route not found`, exactly like a route that does not exist, before any hook runs. `@flag coupons` on an entity hides all its routes, those other natives add for it included. `gate: "beta"` in the options puts every route behind `beta`, and `@flag off` keeps one open. A name the rules do not define fails the build, with a suggestion; the OpenAPI document marks gated operations with `x-feature-flag`.

## Flags in jobs and queue consumers

```ts title="jobs/flag-report.ts"
import { job } from "@quickservicets/core";

/** Reads flags outside a request: for a given user, and anonymously. */
export default job("@daily", (ctx) => ({
  checkoutForU1: ctx.flags.on("checkout-v2", { user: { id: "u1" } }),
  darkMode: ctx.flags.on("dark-mode"),
}));
```

Jobs and queue consumers get `ctx.flags` with the same rules, for the user and tenant they pass; without them the evaluation is anonymous. Other features use `ctx.feature("flags").isOn(name, { user, tenant })`.

## The database source

`source: "database"` adds the internal `FeatureFlag` table (run `quickservicets migration add`). A row replaces the config rule of its name, so the config holds the defaults and the table the changes made at runtime. Each worker loads the rows at startup and every `refresh` (default `30s`); writes through the process's repositories apply as soon as they commit, and a failed reload keeps the last values. The commands manage rows:

```bash
quickservicets flags set checkout-v2 --percentage 20 --users u1,u2
quickservicets flags list
quickservicets flags remove checkout-v2
```

`flags list` shows each flag's origin: `config`, `database` or `both`.

## Environment overrides

Every option has its variable, and so does every rule written in the config: `QS_FLAGS_RULES_CHECKOUT_V2=false` turns `checkout-v2` off, `QS_FLAGS_RULES_CHECKOUT_V2_PERCENTAGE=25` makes it a 25% rollout, and `QS_FLAGS_RULES` takes the whole record as JSON. Hyphens of a name are written as underscores.

## Function rules

A rule can be a function of the request, its user and tenant and the flag's name, returning a boolean synchronously. It is called at most once per request and name; outside requests `req` is undefined. A function that returns anything else, a promise included, fails the request with a 500, and a variable for the rule replaces the function.

```ts
flags: { rules: { "pro-reports": ({ tenant }) => (tenant as { plan?: string } | undefined)?.plan === "pro" } }
```

## `onEvaluate`

`onEvaluate` runs after each new evaluation with `{ name, on, reason, user, tenant, req }`, the reason being `disabled`, `user`, `tenant`, `percentage`, `default`, `function`, `unknown` or `provider`. It observes and cannot change the value; a failing hook is logged. Use it to record exposures for an experiment.

## Providers

`provider` replaces the evaluation of both sources with an object that has `isOn(name, ctx)` and `all(ctx)`, answering synchronously from its own cache, and optional `start()` and `stop()` that run with the server, like a client of Unleash or OpenFeature. `req.flags`, the `@flag` gates and `ctx.flags` then use it. A feature can set one with `ctx.feature("flags").setProvider(provider)`; two providers fail startup.

## Eject

`quickservicets eject flags` copies the native into `features/flags/` as a project feature that replaces it, with the same behavior.

## See also

- [`flags` reference](/reference/features/flags/): every option with its variable, the `@flag` tag, the commands, `onEvaluate` and `FlagProvider`.
- [Hooks](/guides/hooks/): code around routes; the `@flag` gate runs before them.
- [Configuration](/guides/configuration/): the `flags` key among the others.
