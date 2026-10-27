# http

The smallest project that shows the `http` native: `GET /quote` calls a quotes service through `req.http.service("quotes")`, which retries, has a circuit breaker, caches responses and propagates the caller's user; `GET /flaky` shows a retry hiding a failure, and a job fetches a quote with `ctx.http`. `scripts/upstream.ts` is the quotes service, a tiny Bun server on port 4100. The `demo-user` feature is a stand-in for authentication that trusts the `x-user-id` header.

```bash
bun run upstream &
bun run test
```

The HTTP client guide (`docs/src/content/docs/guides/http-client.md`, on the site at `/guides/http-client/`) explains every piece.

## Level 0: enable

The client is enabled by default; call any URL from an endpoint, hook, job or feature, with no config:

```ts
import { http } from "@quickservicets/core";

const quote = await http.get("https://quotes.example.com/random").send<{ text: string }>();
```

## Level 1: options and environment

Declare the services the project calls once, with their base URL, authentication, timeout and modifiers; every option has a `QS_*` variable:

```ts
http: {
  allow: ["loopback"],
  services: {
    quotes: { url: process.env.QUOTES_URL ?? "http://localhost:4100", retry: true, circuitBreaker: true, cache: true, propagate: ["user"] },
  },
}
```

```bash
QS_HTTP_SERVICES_QUOTES_URL=http://quotes.internal:8080 bun .generated/server.ts
```

## Level 2: tags

Not applicable: the client has no tags, because calls are made from code, where every setting is a builder method like `.timeout("2s")` or a service option.

## Level 3: per request

A service's `headers` and `auth` may be functions of the call, run on every call through the service (`req`, `user` and `tenant` are undefined in jobs):

```ts
services: {
  quotes: { url: "http://localhost:4100", headers: ({ tenant }) => ({ "x-plan": (tenant as { plan?: string } | undefined)?.plan ?? "free" }) },
}
```

## Level 4: hooks and events

`beforeRequest` may change every attempt, and `afterResponse` observes each response:

```ts
http: {
  beforeRequest: (request) => {
    request.headers.set("x-signature", sign(request.url));
    return request;
  },
  afterResponse: ({ request, response, durationMs }) => console.info(request.method, request.url, response.status, durationMs),
}
```

## Level 5: override files

Not applicable: the client contributes no entities, endpoints, hooks, jobs or folders, so there are no files to override.

## Level 6: replace the implementation

A `transport` replaces how requests are sent; this one logs every request to the console, then sends it:

```ts
http: {
  transport: {
    fetch(request, { signal }) {
      console.log("calling", request.method, request.url);
      return fetch(request, { signal });
    },
  },
}
```

## Level 7: eject

```bash
quickservicets eject http
```

The native's code is copied into `features/http/`, which replaces it.

## SSRF protection and mocks

Calls to internal networks, the machine itself and cloud metadata endpoints are blocked unless `allow` lists them:

```ts
await http.get("http://169.254.169.254/latest/meta-data").send();
// rejects with code SSRF_BLOCKED: Blocked request to 169.254.169.254: 169.254.169.254 is a link-local address
```

Tests answer the outgoing calls with `http.mock()` (or `mockHttp()` from `@quickservicets/core/testing`), without the upstream:

```ts
const mock = mockHttp();
mock.service("quotes").on("GET", "/quotes/random").reply(200, { text: "Mocked wisdom." });
expect(await (await service.fetch("/quote")).json()).toEqual({ quote: "Mocked wisdom." });
mock.restore();
```
