# tenancy

> Multi-tenancy: every request is resolved to a tenant from a header, a subdomain, a path prefix, the credentials or a function.

Multi-tenancy: every request is resolved to a tenant from a header, a subdomain, a path prefix, the credentials or a function.

## Enabling

Turn it on in `quickservicets.config.ts`:

```ts
tenancy: {}
```

It is not enabled by default: turn it on with `tenancy: {}` or `QS_TENANCY_ENABLED=true`, and off with `tenancy: false` or `QS_TENANCY_ENABLED=false`.

**Runs after:** `http`

## Options

| Key | Type | Default | Environment variable | Per request | Description |
| --- | --- | --- | --- | --- | --- |
| `tenancy.from` | `("header" \| "subdomain" \| "path" \| "auth" \| "function")[]` | `["header"]` | `QS_TENANCY_FROM` | no | Where the tenant id comes from, tried in this order: header, subdomain, path, auth (set by an authentication middleware) or function. |
| `tenancy.header` | `string` | `"x-tenant-id"` | `QS_TENANCY_HEADER` | no | The request header that carries the tenant id for the header source. |
| `tenancy.domain` | `string` | — | `QS_TENANCY_DOMAIN` | no | The base host of the subdomain source: acme.app.example.com is tenant acme when the domain is app.example.com. |
| `tenancy.path` | `string` | `"/t/[tenant]"` | `QS_TENANCY_PATH` | no | The path prefix of the path source, with a [tenant] segment; it is removed before routing. |
| `tenancy.resolve` | `string` | — | `QS_TENANCY_RESOLVE` | yes | The function source: a function of the request and its user returning the tenant id or undefined; required when from lists function. |
| `tenancy.required` | `boolean` | `true` | `QS_TENANCY_REQUIRED` | no | Answers 400 to requests without a tenant on routes that are not exempt; @tenancy required=false relaxes one endpoint. |
| `tenancy.source` | `"database" \| "config" \| "service"` | `"database"` | `QS_TENANCY_SOURCE` | no | Where tenants are looked up: the Tenant table of the service's database, the tenants option, or another service through the HTTP client. |
| `tenancy.tenants.<name>.plan` | `record of string` | — | `QS_TENANCY_TENANTS_<NAME>_PLAN` | no | The tenant's plan, in req.tenant.plan. |
| `tenancy.tenants.<name>.strategy` | `record of "schema" \| "database"` | — | `QS_TENANCY_TENANTS_<NAME>_STRATEGY` | no | Where the tenant's data lives, over tenancy.strategy. |
| `tenancy.tenants.<name>.schema` | `record of string` | — | `QS_TENANCY_TENANTS_<NAME>_SCHEMA` | no | The tenant's schema name, over the tenancy.schema template. |
| `tenancy.tenants.<name>.connection` | `record of string` | — | `QS_TENANCY_TENANTS_<NAME>_CONNECTION` | no | The connection of a database-strategy tenant. |
| `tenancy.tenants.<name>.status` | `record of "active" \| "suspended"` | `"active"` | `QS_TENANCY_TENANTS_<NAME>_STATUS` | no | A suspended tenant's requests answer 403. |
| `tenancy.tenants.<name>.attributes.<name>` | `record of record of string` | — | `QS_TENANCY_TENANTS_<NAME>_ATTRIBUTES_<NAME>` | no | One attribute of the tenant. |
| `tenancy.service` | `string` | — | `QS_TENANCY_SERVICE` | no | The http.services entry of the service source, called as GET /tenants/:id for one tenant and GET /tenants?cursor=… for pages. |
| `tenancy.cache.ttl` | `duration` | `"5m"` | `QS_TENANCY_CACHE_TTL` | no | How long each worker keeps a tenant it looked up. |
| `tenancy.cache.negativeTtl` | `duration` | `"30s"` | `QS_TENANCY_CACHE_NEGATIVE_TTL` | no | How long each worker remembers an unknown tenant id. |
| `tenancy.cache.staleTtl` | `duration` | `"1h"` | `QS_TENANCY_CACHE_STALE_TTL` | no | How long a cached tenant is still used while the directory fails. |
| `tenancy.cache.maxEntries` | `integer` | `10000` | `QS_TENANCY_CACHE_MAX_ENTRIES` | no | Most tenants each worker keeps; the least recently used go first. |
| `tenancy.enabled` | `boolean` | `true` | `QS_TENANCY_ENABLED` | no | Turns the feature off when false. |

## Tags

### `@tenancy`

`@tenancy off` exempts an endpoint from tenant resolution, and `@tenancy required=false` lets it run without a tenant.

**Applies to:** endpoints

**Syntax:** `@tenancy [required=…]` or `@tenancy off`

**Options:** `tenancy.required`

```ts
/** @tenancy off */
export default () => ({ status: "ok" });
```

## Feature API

Other features reach it with `ctx.feature("tenancy")` in their setup, listing `tenancy` in `requires` or `after`.

### `exempt`

```ts
exempt(pattern: string): void;
```

Exempts the paths matching `pattern` (a path, or a path ending in `/*` for it and every path below it) from tenant
resolution: their requests get no `req.tenant` and need none. Only available during setup.

### `find`

```ts
find(id: string): Promise<TenantInfo | undefined>;
```

The tenant with this id from the directory, through the worker's cache, or undefined when there is none.

### `list`

```ts
list(): AsyncIterable<TenantInfo>;
```

Every tenant of the directory, read page by page without the cache.
