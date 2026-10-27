# HTTP client

> Call other HTTP services from endpoints, hooks, jobs and features with a fluent, typed client, protected against SSRF, with named services, retries, circuit breakers, bulkheads, caching, call logs and mocks for tests.

A service rarely lives alone: it reads prices from a catalog, charges through a billing service and calls partners' APIs. The `http` native gives every endpoint, hook, job and feature an outgoing client, `http.get(url).send()`, with timeouts, size limits and clear errors by default, and blocks calls to internal networks unless the project allows them. It is enabled by default and costs nothing until code makes a call. The options, variables, hooks, transport and modifier contracts are listed on the [http reference page](/reference/features/http/).

The samples come from the example project `examples/minimal/http`, which calls a small quotes service started by `scripts/upstream.ts`.

## The builder and its terminals

`http.get`, `http.post`, `http.put`, `http.patch`, `http.delete` and `http.head` take an absolute `http` or `https` URL and return a builder. Every method returns a new builder, so a base builder can be shared:

```ts
import { http } from "@quickservicets/core";

const orders = await http
  .post("https://shop.example.com/orders")
  .json({ sku: "A-1", quantity: 2 })
  .header("x-channel", "web")
  .query({ page: 2, tags: ["new", "sale"] })
  .send<{ id: string }>();
```

- `.json(body)`, `.form(data)` (URL-encoded, or multipart for a `FormData`) and `.body(raw)` set the body.
- `.header(name, value)`, `.headers(record)`, `.bearer(token)` and `.query(record)` add headers and query parameters; arrays repeat the name and `undefined` values are skipped.
- `.timeout("2s")`, `.signal(signal)` and `.use(modifier)` change how the call runs.

The terminals run the call. `.send<T>()` resolves the body of a 2xx response, parsed as JSON for `application/json` and `+json` types, `undefined` when it is empty and the text otherwise; `.text()` and `.bytes()` read it as text or bytes. `.response()` resolves `{ status, ok, headers, url, json(), text(), bytes() }` whatever the status.

## Errors and their codes

A call that fails rejects with an `HttpClientError` carrying `code`, `status`, `method`, `url` (with secret query values masked), `body` (at most 64 KB), `service` and `cause`:

| Code | When |
| --- | --- |
| `HTTP_STATUS` | `.send()`, `.text()` or `.bytes()` got a status outside 2xx: `GET <url> responded 404` |
| `TIMEOUT` | the call took longer than its timeout, reading the body included |
| `ABORTED` | the call's `.signal()` aborted |
| `RESPONSE_TOO_LARGE` | the body is larger than `maxResponseSize` |
| `NETWORK` | the connection or the name resolution failed |
| `INVALID_RESPONSE` | a JSON response did not parse |
| `SSRF_BLOCKED`, `TOO_MANY_REDIRECTS` | SSRF protection refused the call, or it redirected too often |
| `CIRCUIT_OPEN`, `BULKHEAD_FULL` | a circuit breaker or a bulkhead refused the call |
| `MODIFIER_FAILED`, `UNMATCHED_MOCK` | a modifier threw, or no mock handler matched |

## The 502, 503 and 504 answers

An endpoint does not need to catch these errors: one that escapes a handler answers `504 GATEWAY_TIMEOUT` (`Upstream request timed out`) for a timeout, `503 SERVICE_UNAVAILABLE` (`Upstream unavailable`, with `Retry-After` for an open circuit) for a circuit breaker or a bulkhead, and `502 BAD_GATEWAY` (`Upstream request failed`) otherwise. Outside production the response's `details` carry the upstream status and URL; the error is logged like any 500.

## Timeouts and size limits

Every call has a timeout covering the whole call, reading the body included: `timeout` (10 seconds by default), a service's `timeout`, or `.timeout()` on the call, which wins. Bodies larger than `maxResponseSize` (10 MB by default) stop being read and fail with `RESPONSE_TOO_LARGE`.

## SSRF protection and `allow`

Before connecting, the client resolves the host and refuses any address of the machine itself, of private, shared, link-local (cloud metadata included), unique local, reserved, multicast or broadcast ranges, and the names `localhost`, `*.localhost`, `metadata`, `metadata.google.internal` and `instance-data`:

```ts
await http.get("http://169.254.169.254/latest/meta-data").send();
// rejects with SSRF_BLOCKED: Blocked request to 169.254.169.254: 169.254.169.254 is a link-local address
```

It then connects to the address it checked, so a second DNS answer cannot redirect the connection, and follows redirects itself (at most `maxRedirects`), checking every hop and dropping `authorization` and `cookie` across origins. Only `http` and `https` are allowed. Each blocked call logs an `http.ssrf.blocked` warning.

`allow` lets addresses, CIDR blocks (or `loopback`, `private`, `linklocal`) and host names like `billing.internal` or `*.internal` through; the example allows `loopback` because its upstream runs on the same machine. `ssrf: false` turns the protection off, with a warning at a production startup.

## Named services and authentication

Declare each service the project calls once, and call it by name with a path that starts with `/`:

```ts title="quickservicets.config.ts"
import { defineConfig, memoryAdapter } from "@quickservicets/core";

export default defineConfig({
  database: memoryAdapter(),
  "demo-user": {},
  http: {
    // The upstream runs on this machine, which SSRF protection blocks unless allowed.
    allow: ["loopback"],
    services: {
      quotes: { url: process.env.QUOTES_URL ?? "http://localhost:4100", retry: true, circuitBreaker: true, cache: true, propagate: ["user"] },
    },
  },
});
```

```ts title="endpoints/quote/get.ts"
import type { Repositories, ServiceRequest } from "@quickservicets/core";

/** A random quote from the quotes service, with the caller's request id and user propagated. */
export default async (_repos: Repositories, req: ServiceRequest) => {
  const quote = await req.http.service("quotes").get("/quotes/random").send<{ text: string }>();
  return { quote: quote.text };
};
```

The path joins the base URL's path (`https://api.x/v1` and `/invoices` give `https://api.x/v1/invoices`), and calls carry the service's `headers` and its `auth`: one of `bearer`, `basic` or `apiKey`, all secrets masked everywhere. A call's own headers and `.timeout()` win over the service's. Calls through a service trust its host for SSRF protection, so internal services need no `allow` entry. The build generates the service names, so `http.service("nope")` is a type error. Features register their own services during setup with `ctx.feature("http").addService(name, options)`, named `<feature>/<name>`.

## Propagation

`req.http` is the client bound to the request: every call sends the request's id as `x-request-id`, so a request can be followed across services. A service's `propagate` adds `x-user-id` (`user`), `x-tenant-id` (`tenant`) and the incoming `authorization` (`authorization`) to calls through `req.http.service(name)`; the example propagates the user. Calls to other URLs never propagate them, and the global `http` propagates nothing.

Jobs and queue consumers get `ctx.http`, which sends the run or message id:

```ts title="jobs/quote-of-the-day.ts"
import { job } from "@quickservicets/core";

/** Fetches a quote every morning; ctx.http sends the run's id as x-request-id. */
export default job("@daily", async (ctx) => {
  const quote = await ctx.http.service("quotes").get("/quotes/random").send<{ text: string }>();
  ctx.log.info("quote of the day", { text: quote.text });
  return quote;
});
```

## Call logging and masking

Every attempt writes one `http.call` entry with the method, URL, service, status (0 without a response), duration, attempt, request id, error code and, through a cache, `hit`, `miss`, `revalidated` or `bypass`; `info` below 400 and `warn` otherwise. Headers and bodies are never logged, and URLs show `[secret]` for user information and secret query values, like `https://api.test/x?token=[secret]&page=2`. `log: "errors"` keeps only failures, and `log: "off"` silences the entries, globally or per service.

## Modifiers

Modifiers wrap calls. Services turn on the built-in ones with a key, applied in the order retry, circuit breaker, bulkhead, cache; then come the service's `modifiers` list and the call's `.use()` modifiers:

- **Retry** (`retry: true`, or `withRetry(options)`): 3 attempts with exponential backoff and full jitter, or the response's `Retry-After`, for `GET`, `HEAD`, `OPTIONS`, `PUT` and `DELETE` (and `POST` or `PATCH` with an `Idempotency-Key`), on 408, 429, 502, 503, 504, network failures and timeouts. In the example, `GET /flaky` reaches an upstream route that fails every other time and still answers 200.
- **Circuit breaker** (`circuitBreaker: true`, or `withCircuitBreaker`): 5 failures within 30 seconds open the circuit for 30 seconds, then one trial call closes it or opens it again; `http.state("quotes")` reports it.
- **Bulkhead** (`bulkhead: true`, or `withBulkhead`): at most 10 calls at once per worker, 100 waiting up to 5 seconds.
- **Cache** (`cache: true`, or `withCache`): `GET` and `HEAD` responses kept in memory per worker, following `Cache-Control`, `Vary`, `ETag` and `Last-Modified`; calls with credentials bypass it unless `private: true`. In the example the second `GET /quote` within a minute does not reach the upstream.

A custom modifier is a function of the request and `next`:

```ts
import { defineModifier, http } from "@quickservicets/core";

const timing = defineModifier(async (request, next) => {
  const started = performance.now();
  const response = await next();
  console.info(request.url, response.status, performance.now() - started);
  return response;
});

await http.get("https://api.example.com/items").use(timing).send();
```

Features register named modifiers that services list in `modifiers` with `ctx.feature("http").modifier(name, modifier)`.

## `http.mock()` in tests

`http.mock()` (or `mockHttp()` from `@quickservicets/core/testing`) answers every outgoing call of the process from canned handlers until `restore()`, without a network; modifiers, timeouts, size limits and logging still run. The example's test answers the quotes service without the upstream:

```ts
const mock = mockHttp();
mock.service("quotes").on("GET", "/quotes/random").reply(200, { text: "Mocked wisdom." });
expect(await (await service.fetch("/quote")).json()).toEqual({ quote: "Mocked wisdom." });
mock.restore();
```

Handlers match a method and an exact URL, a prefix ending in `*`, a `RegExp` or a service path; `.reply()`, `.replyWith(fn)`, `.fail("network")`, `.delay("2s")` and `.once()` decide the answer, and `mock.calls` lists every call. An unmatched call fails with `UNMATCHED_MOCK`.

## Environment overrides

Every option has a variable: `QS_HTTP_TIMEOUT=2s`, `QS_HTTP_ALLOW=10.0.0.0/8`, `QS_HTTP_SSRF=false`, `QS_HTTP_LOG=errors`, and per service `QS_HTTP_SERVICES_QUOTES_URL`, `QS_HTTP_SERVICES_QUOTES_AUTH_BEARER` or `QS_HTTP_SERVICES_QUOTES_RETRY_ENABLED=false`, with hyphens of a service's name written as underscores. `QS_HTTP_ENABLED=false` turns the client off.

## Per-request functions

A service's `headers` and `auth` may be functions of the call, run on every call through the service; `req`, `user` and `tenant` are undefined in jobs and consumers:

```ts
services: {
  billing: { url: "https://billing.internal", auth: async ({ tenant }) => ({ bearer: await tokenFor(tenant) }) },
}
```

## Hooks

`beforeRequest` runs before every attempt and may return a changed request, or throw to cancel the call; `afterResponse` and `onError` observe each attempt. Features add them with `ctx.feature("http").beforeRequest(fn)`, `.afterResponse(fn)` and `.onError(fn)`.

```ts
http: {
  beforeRequest: (request) => {
    request.headers.set("x-signature", sign(request.url));
    return request;
  },
}
```

## Transports

`transport` replaces how a request is sent, for a proxy, a test double or another HTTP stack: its `fetch(request, { signal, address })` gets a standard `Request` and the address SSRF protection validated. Redirects, size limits, logging and modifiers keep working above it.

## Eject

```bash
quickservicets eject http
```

The native's code is copied into `features/http/`, which replaces it; the core's `http` keeps using the copy.

## Related reference

- [http reference](/reference/features/http/): every option with its variable, the hooks and the contracts.
- [Configuration](/guides/configuration/): where the `http` key goes.
- [Jobs](/guides/jobs/): `ctx.http` in scheduled and on-demand runs.
