---
title: WebSockets
description: Serve WebSockets from ws.ts files with typed and validated messages, rooms kept apart per tenant, publishing from any code, limits and close codes, and room messages across workers and replicas through PostgreSQL.
sidebar:
  order: 54
---

A support chat needs both directions at once: agents and customers type, everyone in the conversation sees it at once, and the service itself announces when an agent joins. WebSockets keep one connection open in both directions. The `realtime` native serves them from `ws.ts` files, with the same authentication, tags and hooks as any endpoint, typed messages, rooms, limits and delivery across workers and replicas. The options, variables, tags, hooks, the `sockets` API and the close codes are listed on the [realtime reference page](/reference/features/realtime/).

The samples come from the example project `examples/minimal/realtime`, which also streams Server-Sent Events: a chat room at `/rooms/[roomId]` for signed-in users and an announcement endpoint.

```ts title="quickservicets.config.ts"
import { defineConfig, memoryAdapter } from "@quickservicets/core";

export default defineConfig({
  database: memoryAdapter(),
  events: {},
  // The rooms socket is for signed-in users; the tests sign them in with testAuth().
  auth: {},
  realtime: {},
});
```

## `ws.ts` and `defineSocket`

With `realtime: {}`, a file named `ws.ts` in `endpoints/` is a `GET` route upgraded to a WebSocket. It default-exports `defineSocket({ open, message, close, drain })`: every handler receives the socket and a context with the route's `params`, the `query`, the `user`, the `tenant`, the request's `repos`, a `log` and the upgrade request `req`, kept for the socket's life. A socket offers `send` (strings as text, `Uint8Array` as binary, anything else as JSON), `close(code, reason)`, `id`, `user`, `tenant`, `params`, a `data` object of your own and `readyState`. A folder has one `GET` route, so `ws.ts` cannot sit next to `get.ts` or `sse.ts`.

```ts title="endpoints/rooms/[roomId]/ws.ts"
import { defineSocket } from "@quickservicets/core";

/** What clients send: a line of chat (with an optional `id` to get an acknowledgment), or that they are typing. */
type In = { type: "say"; text: string } | { type: "typing" };
/** What the room receives. */
type Out = { type: "said"; text: string; from: string } | { type: "typing"; from: string };

/**
 * A chat room: every signed-in client joins `room:<roomId>` and hears the others.
 * @auth
 */
export default defineSocket<{ in: In; out: Out }>({
  open: (ws, ctx) => ws.subscribe(`room:${ctx.params.roomId}`),
  on: {
    say: (ws, message, ctx) => {
      ws.publish(`room:${ctx.params.roomId}`, { type: "said", text: message.text, from: ws.user!.id });
      // A message sent with an `id` gets { id, result } back.
      return { delivered: true };
    },
    typing: (ws, _message, ctx) => ws.publish(`room:${ctx.params.roomId}`, { type: "typing", from: ws.user!.id }),
  },
});
```

## The upgrade and its hooks

A request without `Upgrade: websocket` answers 426 `This route needs a WebSocket connection`. Otherwise the handler middlewares run first (authentication, tenancy, `@auth` and `@roles`), then the endpoint's pre-hooks and the `beforeConnect` hooks; any of them may refuse with an HTTP answer, and only then is the connection upgraded. Post-hooks never see a socket.

## Authentication from browsers

Browsers cannot set headers on a WebSocket, so a socket authenticates like this:

- With a session cookie: the browser sends it with the upgrade, and the auth provider reads it like any request.
- With a token in `Sec-WebSocket-Protocol`: `new WebSocket(url, ["token.<value>"])`; a provider that lists that header among its credentials reads it, and the service answers with the first offered protocol, as browsers require.
- With a token in the query, like `?access_token=…`: simple, but URLs end up in proxy and access logs, so use short-lived tokens there.

`@auth` on the `ws.ts` file answers 401 to anonymous upgrades, and `ctx.user` holds the user for the socket's life. Revoking a session (`ctx.feature("auth").revoke({ sessionId })`) closes its sockets with 4401.

## Origin checks

A browser upgrade carries `Origin`; the service accepts only its own origin and `websockets.origins` (by default `security.cors.origins`), and answers 403 `Origin not allowed` to others, so another site cannot ride on a user's cookies. Clients without `Origin` (servers, mobile apps) pass.

## Typed messages, routing by type and acknowledgments

`defineSocket<{ in; out; data? }>` types what clients send (`in`), what the socket sends (`out`) and `ws.data`. The build turns `in` into a validator: text frames are parsed as JSON once and validated once, and an invalid frame answers `{ "error": { "code": "INVALID_MESSAGE", … } }` with the path of each problem, keeping the socket open; binary frames are refused. A union discriminated by `type` routes each message to its `on` handler, typed by its member; a type no member declares goes to `message`, or answers `UNKNOWN_MESSAGE_TYPE`. A message that carries an `id` gets `{ "id": …, "result": … }` with the handler's return value, or `{ "id": …, "error": … }` when it throws an `HttpError`. `/openapi.json` documents the message schemas as `<Route>SocketIn` and `<Route>SocketOut`.

## Rooms and tenant namespaces

`ws.subscribe(room)` and `ws.unsubscribe(room)` join and leave rooms through Bun's own pub/sub; `ws.rooms` lists them, and a socket joins at most `websockets.maxRooms` (100). `ws.publish(room, data)` reaches the room's other sockets. Room names match `^[A-Za-z0-9][A-Za-z0-9:_./-]{0,199}$`. With `tenancy` on, every room lives in its tenant's namespace, so two tenants never share one: a socket of `acme` in `room:1` never hears `globex`'s `room:1`.

## Publishing from endpoints and jobs

`sockets` of `@quickservicets/core` reaches the sockets from any code: `sockets.publish(room, data, { except?, tenant? })`, `sockets.disconnect({ user?, sessionId?, tenant?, room? })` and `sockets.count(room)`. Code running for a tenant publishes to its tenant's rooms; a job in the root scope names the tenant.

```ts title="endpoints/rooms/[roomId]/announce/post.ts"
import { sockets, type Endpoint } from "@quickservicets/core";

/** @summary Sends an announcement to everyone in a room */
const handler: Endpoint<{ text: string }, { sent: true }> = async (_repos, req) => {
  const { text } = await req.json();
  sockets.publish(`room:${req.params.roomId}`, { type: "said", text, from: "announcer" });
  return { sent: true };
};

export default handler;
```

## Limits and close codes

Each worker keeps at most `maxConnections` sockets (more upgrades answer 503 with `Retry-After: 5`), a frame is at most `maxMessageSize`, a socket sends at most `messages` frames per window, and a silent socket closes after `idleTimeout` (Bun pings live ones). The close codes:

| Code | When |
| --- | --- |
| 1001 | The service is shutting down |
| 1008 | Too many messages |
| 1009 | A frame over `maxMessageSize` |
| 1011 | A handler threw an error other than `HttpError` (logged as `realtime.socket.failed`) |
| 4001 | `sockets.disconnect` |
| 4401 | The session was revoked |

Every closed socket writes one request log entry with its duration, `messagesIn`, `messagesOut` and close code.

## Workers and replicas

`websockets.transport` decides how room messages and disconnects reach sockets held by other workers and replicas:

- `"local"` (the default) delivers within the process only; with `server.workers` above 1 the service warns once at startup.
- `"postgres"` uses `LISTEN` and `NOTIFY` on the project's PostgreSQL database: no other service to run. Delivery is at most once (nothing sent while the listening connection is down arrives), a payload is at most `postgres.maxPayload` (7900 bytes, under PostgreSQL's 8000-byte limit; larger messages reach local sockets only), the channel gets the default schema as a suffix, and with `health` on the non-critical `realtime.transport` check fails while the listening connection is down.

```ts
realtime: { websockets: { transport: "postgres" } }
```

Writing a transport means implementing `SocketTransport`: `start({ onMessage, onDisconnect, logger })`, `publish(envelope)`, `disconnect(filter)` and `stop()`. An envelope is `{ origin, room, data, binary?, except? }`: the room is already in its tenant's namespace, and a process skips its own envelopes by `origin`. `runSocketTransportContract` of `@quickservicets/core/testing` checks one with two instances.

## Proxies and load balancers

A proxy in front of the service must forward the upgrade (`Upgrade` and `Connection` headers; in nginx, `proxy_http_version 1.1` with both headers set) and keep idle connections open longer than `idleTimeout`. Sticky sessions are not required: any worker accepts a socket, and the transport delivers room messages to the others.

## WebSockets or Server-Sent Events

Server-Sent Events are one-way, plain HTTP, reconnect by themselves and resume with `Last-Event-ID`; they fit feeds, dashboards and change streams. WebSockets go both ways with low overhead per message; they fit chat, presence, games and collaborative editing. Both live in the `realtime` native, and a service may use both.

## Customization

Every level of the native, as the example's README shows:

- Level 0: `realtime: {}` and a `ws.ts` file.
- Level 1: every option has a variable, like `QS_REALTIME_WEBSOCKETS_MESSAGES=20/10s`.
- Level 2: `@socket messages=5/s origins=https://chat.example` on one `ws.ts` file.
- Level 3: `messages` as a function, like a higher rate for `pro` tenants.
- Level 4: the hooks `beforeConnect`, `afterConnect`, `beforeMessage`, `beforeSubscribe` (like refusing other users' private rooms), `beforePublish` and `onClose`, also through `ctx.feature("realtime").addHook`.
- Level 5: a project `ws.ts` replaces a project feature's at the same path.
- Level 6: `transport: "postgres"`, or a transport of your own (or `ctx.feature("realtime").setTransport()` in a feature).
- Level 7: `quickservicets eject realtime`.

## A browser client

```js
const socket = new WebSocket(`wss://api.example.com/rooms/lobby`);
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.type === "said") console.log(`${message.from}: ${message.text}`);
  if (message.id !== undefined) console.log("acknowledged", message.id, message.result ?? message.error);
});
socket.addEventListener("close", (event) => {
  if (event.code === 4401) location.assign("/sign-in");
});
socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, type: "say", text: "hello" })));
```
