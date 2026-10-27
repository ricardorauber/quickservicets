# tenancy

The smallest project that shows the `tenancy` native: every request names its tenant in the `x-tenant-id` header, which `req.tenant.id` carries; a request without it answers 400, and `GET /status` is exempt.

```bash
bun run test
```

## Level 0: enable

```ts
tenancy: {}
```

```bash
curl localhost:3000/whoami -H "x-tenant-id: acme"
```

## Level 1: options and environment

`from` lists the sources, tried in order; `header`, `domain` and `path` configure them:

```ts
tenancy: { from: ["subdomain", "header"], domain: "app.example.com" }
```

```bash
QS_TENANCY_HEADER=x-org bun run start
```

## Level 2: tags

```ts
/**
 * The service status, answered to every caller without a tenant.
 * @tenancy off
 */
export default () => ({ status: "ok" });
```

## Level 3: per request

The function source decides the tenant of each request:

```ts
tenancy: { from: ["function"], resolve: ({ req }) => req.query.get("org") ?? undefined }
```

## Level 4: hooks and events

Not applicable: the native has no hooks yet.

## Level 5: override files

Not applicable: the native contributes no entities, endpoints or jobs yet.

## Level 6: replace the implementation

Not applicable: the native has no replaceable implementation yet.

## Level 7: eject

```bash
quickservicets eject tenancy
```
