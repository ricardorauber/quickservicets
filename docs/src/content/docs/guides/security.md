---
title: Security
description: The protections every service has by default (security headers, CORS, request limits, timeouts, load shedding, rate limits, IP lists and log masking), what each one stops, and how to tune it.
sidebar:
  order: 48
---

Every service starts with the `security` native on. Its protections are separate items, each with safe defaults, each switchable on its own, run in a fixed order before routing, and cheap enough per request to leave on (the benchmark budget is 5% on the CRUD scenario). The options, variables, tags and hooks are listed on the [security reference page](/reference/features/security/).

The samples come from the example project `examples/minimal/security`: posts, customers with a tax id that never reaches the logs, a login endpoint with its own rate limit, admin statistics for the private network, and an `audit` feature that logs created customers.

## What each item stops

| Item | Threat | Default | Response |
| --- | --- | --- | --- |
| `proxy` | A client spoofing its address with `x-forwarded-for` to escape rate limits and IP lists | No proxy trusted: `req.ip` is the socket's address | none |
| `headers` | Clickjacking, MIME sniffing, referrer leaks and content injection in a browser | `nosniff`, `no-referrer`, `DENY`, a `default-src 'none'` policy; HSTS in production | headers on every response |
| `files` | An uploaded HTML or SVG file running as a page of the service's origin | `nosniff`, a sandboxing policy, `attachment` for active types | headers on file responses |
| `cors` | A page of another origin reading the API with the user's browser | Closed: no origin allowed | `403` to a refused preflight |
| `limits` | Memory and CPU spent on huge URLs, headers and bodies | URL 8 KB, headers 16 KB and 100 of them, body 1 MB | `414`, `431`, `413` |
| `timeouts` | Slow clients holding connections open (slowloris) | Idle 30 s, body read 30 s, upload 10 min | `408`, connection closed |
| `loadShedding` | Overload making every request slow until the worker falls over | 1000 requests in flight per worker | `503` with `Retry-After` |
| `rateLimit` | Brute force, scraping and one client starving the others | 1000 requests a minute per address | `429` with `Retry-After` and `RateLimit-*` |
| `ip` | Calls from addresses that should never reach a route | No list | `403` |
| `mtls` | Callers that cannot prove which service they are | Off: needs `ca` and `server.tls`, or a trusted proxy's header | handshake refused, `401`, `403` |
| `masking` | Passwords, tokens and personal data leaking through logs and error reports | The default keys, `@sensitive` fields and secret values | `[secret]` and `[sensitive]` in logs |

Client certificates, HTTPS from the service, forwarded identities from a mesh and certificates for outgoing calls are covered by the [mTLS guide](/guides/mtls/).

Every refusal is an `HttpError` passing through the `error` stage, so an `error` middleware can change its response, and the security headers are added to refusals too.

## The order of the items

Before routing, the items run in this order, so the cheapest refusals come first: load shedding, URL and header limits, IP lists, CORS, rate limits keyed by address or route, then the body policy (size and read deadline). On the way out, the response gets the security headers, the CORS headers and the rate limit headers. Rate limits keyed by user or tenant, or computed per request, run later, in the handler stage, after the middleware that sets `req.user`.

A feature that runs after `security` exempts paths from items, like health probes that a load balancer must always reach:

```ts
ctx.feature("security").exempt("/health/*", ["rateLimit", "loadShedding", "ip"]);
```

## Security headers

`headers` adds `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` and `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` to every response that does not have them, errors and `404` included; a header the handler set wins, and an empty option leaves its header out. `GET /docs` gets `docsCsp`, which lets the API docs page load its pinned script. In production, `Strict-Transport-Security: max-age=31536000; includeSubDomains` is added; `hsts: { preload: true }` opts into preloading, and `hsts: false` turns it off. `@securityHeaders csp="..."` changes the policy of one route, and `@securityHeaders off` sends none of these headers there.

## Served files

`files` makes the file routes of `proxy` and `signed` modes send `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`, and serves the types of `files.attachmentTypes` (HTML, SVG, XML, JavaScript, CSS) with `Content-Disposition: attachment`, so a browser never runs an uploaded file as a page of the service. Files in `direct` mode are served by the storage or the CDN, which needs the same headers set there: the service never sees those requests.

## CORS

CORS is closed until `cors.origins` lists origins: exact origins like `https://app.example.com`, `*`, subdomain patterns like `https://*.example.com`, or `null`. A preflight from an allowed origin gets `204` with the allowed methods and headers and `Access-Control-Max-Age` (10 minutes); from another origin, or asking for a method or header outside the lists, it gets `403`. Requests from allowed origins get `Access-Control-Allow-Origin` and `Vary: Origin`; others proceed without them, so the browser keeps the answer from the page. `credentials: true` with `origins: ["*"]` is a configuration error. `@cors origins=https://partner.example credentials=true` gives one route its own origins, `@cors off` turns CORS off there, and an `options.ts` endpoint answers the preflights of its path itself. The example opens CORS to its browser app:

```ts title="quickservicets.config.ts"
import { defineConfig, memoryAdapter } from "@quickservicets/core";

// The security native is on by default: only CORS is opened, for the browser app of the project.
export default defineConfig({
  database: memoryAdapter(),
  security: { cors: { origins: ["http://localhost:5173"] } },
  audit: {},
});
```

## Request limits and timeouts

`limits` refuses a path and query longer than `url` (8 KB) with `414`, headers larger than `headers` (16 KB) or more than `headerCount` (100) with `431`, and a body declaring more than `body` (1 MB) with `413` before it is read; a streamed body is counted while it arrives and refused once it passes the limit. Multipart uploads keep their own limits (`files.maxSize`, `@maxSize`, `@maxTotalSize`), and the server is started with a socket body limit that is the largest any route accepts. `@limits body=20MB` raises the limit of one route, like an import endpoint.

`timeouts` closes connections idle for `idle` (30 s, at most 255 s, the Bun limit) and refuses with `408` and `connection: close` a body that has not fully arrived `read` (30 s) after the first read, or `upload` (10 min) for multipart uploads.

## Load shedding

`loadShedding` counts each worker's requests in flight and refuses new ones with `503 Server is busy` and `Retry-After` once `maxInFlight` (1000) is reached, logging `security.load-shed` at most once a second. A streamed response stops counting once it starts. Load shedding only keeps one worker responsive under overload: it does not protect the network or the machine.

## Rate limits

`rateLimit` gives each client address `limit` requests per window (1000 a minute), with a sliding window over the current and previous minute. A refused request gets `429 Too many requests` with `Retry-After`, and every response of a limited request carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`. `by` keys the global limit by `ip`, `route`, `user` or `tenant`; user and tenant keys fall back to the address for anonymous requests. `@rateLimit` adds a bucket for one route, always keyed by route, on top of the global limit:

```ts title="endpoints/login/post.ts"
import type { Endpoint } from "@quickservicets/core";

/**
 * Signs a user in; five attempts a minute per address slow down password guessing.
 * @rateLimit 5/min
 */
const login: Endpoint<{ email: string; password: string }, { signedIn: string }> = async (_repos, req) => {
  const { email } = await req.json();
  return { signedIn: email };
};

export default login;
```

`@rateLimit 10/min by=user` keys a route's bucket by user, `@rateLimit off` exempts a route from every limit (like a webhook), and `limit` may be a function of the request, its user and tenant.

### Trusted proxies

Behind a load balancer, every request comes from the balancer's address, so a limit per address would be one limit for everyone. List the balancer in `proxy.trust` (addresses, CIDR blocks or `private`) and `req.ip` becomes the client's address from `x-forwarded-for` (or `forwarded`, or another header with `proxy.header`), read from the right and skipping trusted hops. Forwarding headers from untrusted peers are ignored, since any client can send them; in production the first one logs `security.proxy.untrusted`. A CDN that sends the address in its own header, like `cf-connecting-ip`, is read with `proxy.resolver`.

### Memory and database counters

The memory store keeps the counters in each worker: with `server.workers: 4`, each worker counts on its own and startup logs `security.rateLimit uses per-worker memory counters`. `rateLimit.store: "database"` shares the counters across workers and replicas through the project's database (rebuild and run `quickservicets migration add` for the `rate_limit_counters` table): each worker decides on its local counts and sends them every `syncInterval` (1 s) with one write per bucket, so a client can pass the limit by at most what the other workers accept within one interval, and a database outage keeps requests flowing on local counts. A store object in `rateLimit.store`, or one a feature sets with `ctx.feature("security").rateLimitStore(store)`, replaces both.

## IP lists

`ip.allow` serves only the listed addresses, `ip.deny` refuses the listed ones (a deny match wins), both with `403 Address not allowed` and without saying which list matched; entries are addresses, CIDR blocks or `loopback`, `private` and `linklocal`. Route tags add to the global lists, so they can only narrow access:

```ts title="endpoints/admin/stats/get.ts"
import type { Endpoint } from "@quickservicets/core";

/**
 * Counts the records; only the private network and the machine itself may ask.
 * @ipAllow private,loopback
 */
const stats: Endpoint<unknown, { posts: number; customers: number }> = async (repos) => ({
  posts: await repos.posts.query().count(),
  customers: await repos.customers.query().count(),
});

export default stats;
```

### Lists that change while the service runs

`ip.source` adds entries that come from somewhere that changes at runtime, without a restart. A source is an `IpListSource`: `load()` resolves `{ allow, deny }`, and an optional `watch(onChange)` calls `onChange` when the lists changed and returns a function that stops watching. The lists in effect are the config lists plus the loaded ones, with the same rules.

```ts
import { databaseIpList, defineConfig } from "@quickservicets/core";

export default defineConfig({
  security: { ip: { deny: ["198.51.100.7"], source: databaseIpList({ entity: "IpRule" }), refresh: "30s" } },
});
```

- Each worker loads the source once before it accepts requests, then every `refresh` (`QS_SECURITY_IP_REFRESH`, default `30s`) and after every `watch` notification; loads never overlap, and notifications during a load cause one more load after it.
- Every successful load is validated (invalid entries are skipped and logged as `security.ip.source.invalid`), compiled off the request path and swapped in with one assignment, so a request sees the old or the new lists, never a mix.
- A load that fails or takes longer than `refresh` keeps the lists in effect (the config lists when no load succeeded yet) and logs `security.ip.source.failed` at most once a minute; startup never fails because of it.
- `ctx.feature("security").ip.reload()` loads the source now in the calling worker and resolves the `{ allow, deny }` counts once the new lists apply, or rejects with the load error.
- `databaseIpList({ entity })` reads every record of a project entity with the fields `cidr`, `list` (`"allow"` or `"deny"`), `expiresAt?` and `note?`, skipping expired records and reading in the root scope with tenancy; every write to the entity in the process reloads the lists at once, so admins manage them through the entity's normal routes. An entity without `cidr` and `list` fails startup with `databaseIpList: entity <name> needs the fields cidr and list`.

```ts
// entities/IpRule.ts
export type IpRule = {
  cidr: string;
  list: "allow" | "deny";
  expiresAt?: Date;
  note?: string;
};
```

Without a source the item does exactly the work of the static lists: no timer and no observer.

## Masking

`masking` passes every log entry through `maskEntry`: a property whose name contains one of `keys` (`password`, `token`, `authorization` and the other defaults, ignoring case, `-` and `_`) shows `[secret]`, a property named like a field tagged `@sensitive` shows `[sensitive]`, and the values of secret variables and options show `[secret]` wherever they appear in a string. Job run records store masked logs, results and errors, and development error responses mask secret values in the stack. `@sensitive` never changes API responses; `@hidden` is what leaves a field out of them.

```ts title="entities/Customer.ts"
export type Customer = {
  name: string;
  /** @sensitive */
  taxId: string;
};
```

The example's `audit` feature logs every created customer, which shows the tax id as `[sensitive]`:

```ts title="features/audit/index.ts"
import { defineFeature } from "@quickservicets/core";

/** Logs every created customer; the security native shows its `@sensitive` tax id as `[sensitive]`. */
export default defineFeature({
  key: "audit",
  setup(ctx) {
    ctx.app.use({
      stage: "handler",
      async run(req, _res, next) {
        const result = await next();
        if (req.method === "POST" && req.route === "/customers") ctx.logger.info({ timestamp: new Date().toISOString(), message: "customer.created", customer: result });
        return result;
      },
    });
  },
});
```

`maskUrl(url, rules)` masks the user information and secret query parameters of a URL before it is logged.

## Customizing

Every level of customization applies: each option has its `QS_SECURITY_*` variable (lists are comma-separated, like `QS_SECURITY_CORS_ORIGINS=https://a.example,https://b.example`); the tags `@rateLimit`, `@cors`, `@ipAllow`, `@ipDeny`, `@securityHeaders`, `@limits` and `@sensitive` tune single routes and fields; `rateLimit.limit` and `cors.origins` may be functions of the request; the hooks `rateLimit.onLimited`, `ip.onBlocked`, `cors.onRejected`, `loadShedding.onShed` and `limits.onRejected` observe refusals (their errors are logged and never change the response); `rateLimit.store` and `proxy.resolver` replace the implementations; and `quickservicets eject security` copies the native into `features/security/`.

## What must be handled before the application

Some attacks never reach code that can stop them:

- Volumetric DDoS and caps on TCP connections must be handled before the application, by a CDN like Cloudflare or by the load balancer: by the time a flood reaches the service, the network and the machine are already saturated.
- Load shedding only keeps one worker responsive; it does not limit connections, and it cannot absorb more traffic than the machine can receive.
- Files in `direct` mode are served by the storage or the CDN, which need the `nosniff`, sandboxing and `attachment` headers set there.

## Checks around the code

- The attack suite (`runAttackSuite` from `@quickservicets/core/testing`) sends SQL injection payloads, operator objects and malicious names to every route shape on each database and checks that nothing leaks or changes; it runs on the memory adapter and SQLite always, and on PostgreSQL and MongoDB when `TEST_POSTGRES_URL` and `TEST_MONGODB_URL` are set. It starts the app as `startService` does, with the natives enabled by default, so security (headers, limits, timeouts, load shedding, rate limiting, IP lists and masking at their defaults) handles every request: a payload that makes the URL longer than `security.limits.url` is expected to get 414 `URL is too long`, and the same payload in a body is still stored and read back byte for byte. Pass `config` to change what it resolves, like `runAttackSuite({ name: "memory, security off", adapter: () => memoryAdapter(), config: { security: false } })` or `config: { security: { limits: { url: "64KB" } } }`; the adapter and a quiet logger are always applied.
- The `unsafe()` rule: outside the database adapters, `unsafe()` must receive literal SQL text; `bun run typecheck` fails on built text unless a `// quickservicets-allow-unsafe: <reason>` comment above the call says why.
- `bun run audit` audits the dependencies and fails on critical vulnerabilities, unless `scripts/audit-allow.json` allows one with a reason and an expiry date.
