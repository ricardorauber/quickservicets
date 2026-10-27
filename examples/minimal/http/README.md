# http

The smallest project that shows the `http` native: `GET /quote` calls an upstream service with `http.get(url).send()` and answers its quote; an upstream that cannot be reached answers 502.

```bash
bun run test
```

## Level 0: enable

The client is enabled by default; call it from any endpoint, hook, job or feature:

```ts
import { http } from "@quickservicets/core";

const quote = await http.get("https://quotes.example.com/random").send<{ text: string }>();
```

## Level 1: options and environment

`timeout`, `maxResponseSize` and `userAgent` set the defaults of every call:

```ts
http: { timeout: "5s", maxResponseSize: "1MB" }
```

## Level 2: tags

Not applicable: calls are made from code, where each setting is a builder method like `.timeout("2s")`.

## Level 3: per request

Not applicable: each call sets its own headers, query, body and timeout with the builder.

## Level 4: hooks and events

Not applicable: the client has no hooks yet.

## Level 5: override files

Not applicable: the client contributes no entities, endpoints, hooks, jobs or folders.

## Level 6: replace the implementation

Not applicable: the client has no replaceable implementation yet.

## Level 7: eject

```bash
quickservicets eject http
```
