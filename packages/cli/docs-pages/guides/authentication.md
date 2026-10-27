# Authentication

> One contract for every way of signing users in, the @auth and @roles tags, scopes, the 401 and 403 answers, OpenAPI security, the account protection kit, CSRF for cookie sessions, revocation and testing with testAuth().

The `auth` native gives every authentication provider one contract. A provider (Keycloak, BetterAuth, your own API keys, or `testAuth()` in tests) reads the credentials of a request and returns who it is; the native puts the answer in `req.user` and `req.auth`, and the routes, tags, rate limits, events, error reports and the tenant check all work the same whatever signed the user in. The options, variables, tags, hooks, the setup API and the error codes are listed on the [auth reference page](/reference/features/auth/).

The samples come from the example project `examples/minimal/auth`: a project-written provider checks the `x-api-key` header, `Post` is readable by anyone signed in and writable by editors, and `GET /me` answers the signed-in user.

```ts title="quickservicets.config.ts"
import { addAuthScheme, defineConfig, memoryAdapter, secret } from "@quickservicets/core";
import { apiKeyProvider } from "./lib/api-key.ts";

export default defineConfig({
  database: memoryAdapter(),
  env: { API_KEY: secret().optional() },
  auth: { providers: [apiKeyProvider()] },
  // The API docs say how to send the key, so the docs page and generated clients can authenticate.
  docs: { openapi: (doc) => addAuthScheme(doc, "apiKey", { type: "apiKey", in: "header", name: "x-api-key" }) },
});
```

## The contract and req.user

A provider is an object with a `name`, the `credentials` it reads (header, cookie and query parameter names), an `authenticate(req)` method, an optional `challenge` (the `WWW-Authenticate` value it offers) and an optional `revoke`. For each request, the native looks up each credential name once; a request that carries none of them calls no provider. Otherwise the providers that own a present credential are called in registration order, until one returns a result:

- `req.user` is `{ id, roles, email, name, claims }`, with `roles` `[]` and `claims` `{}` when the provider gives none.
- `req.auth` is `{ provider, method, sessionId, expiresAt, scopes }`, where `method` is `bearer`, `cookie`, `apiKey`, `certificate` or `test`.
- With a `tenant` in the result, `req.tenant` is `{ id }`, and the `tenancy` native refuses a request for another tenant.

`authenticate` returns `null` for credentials that are not its own, and throws `AuthError` for expired, malformed or revoked ones.

## Writing a provider

```ts title="lib/api-key.ts"
import { timingSafeEqual } from "node:crypto";
import { AuthError, env, type AuthProvider } from "@quickservicets/core";

const same = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** A project-written provider: the `x-api-key` header must equal the `API_KEY` variable, and signs in an editor. */
export function apiKeyProvider(): AuthProvider {
  return {
    name: "api-key",
    credentials: { headers: ["x-api-key"] },
    challenge: 'ApiKey header="x-api-key"',
    authenticate(req) {
      const expected = env.API_KEY;
      if (!expected) throw new AuthError("API_KEY is not set");
      if (!same(req.headers.get("x-api-key") ?? "", expected)) throw new AuthError("unknown key");
      return { user: { id: "api-client", roles: ["editor"] }, method: "apiKey" };
    },
  };
}
```

The `providers` option registers it, before any provider a feature registers with `ctx.feature("auth").provider(p)`. Providers that sign users in with a password use the [account protection kit](#the-account-protection-kit).

## @auth, @roles and their operations

```ts title="entities/Post.ts"
/**
 * Anyone signed in reads posts; only editors write them.
 * @auth
 * @roles editor:write
 */
export type Post = {
  /** @minLength 1 */
  title: string;
};
```

- `@auth` requires a signed-in user on every route of an entity, or on one endpoint; `@auth off` keeps the target public when `required` is true.
- `@roles` lists roles of which the user must hold one. On entities, an entry may name an operation of the generated routes (`list`, `read`, `create`, `update`, `replace`, `delete`) or a group (`view` is list and read, `write` the other four): `@roles editor:write,admin:delete`. An unknown operation, or an operation on an endpoint, fails the build with `invalid @roles`.
- `@roles` implies `@auth` on the routes it restricts.
- An entity's tags apply to every route served for it: the generated and file routes, its history routes (as `read`) and its change stream (as `list`). An endpoint's own tags win over its entity's.

Custom code checks the same way with `requireUser(req)` and `requireRole(req, ...roles)`:

```ts title="endpoints/me/get.ts"
import { requireUser, type Endpoint } from "@quickservicets/core";

/** @summary The signed-in user */
const handler: Endpoint = (_repos, req) => requireUser(req);

export default handler;
```

## Scopes

`@auth scopes=posts:write` also requires token scopes, compared with `req.auth.scopes`; the `scopes` option requires some on every route that needs a user.

## The 401 and 403 answers

| Status | Message | When |
| --- | --- | --- |
| 401 | `Authentication required` | The route needs a user and the request has none; `WWW-Authenticate` lists the providers' challenges. |
| 401 | `Invalid credentials` | A provider refused the request's credentials, on every route, public ones included; bearer challenges add `error="invalid_token"`. |
| 403 | `Not allowed` | The user holds none of the route's roles. |
| 403 | `Insufficient scope` | The credentials lack a scope; `WWW-Authenticate: Bearer error="insufficient_scope", scope="..."`. |

Every 401 is logged as `auth.failed` with the provider, the reason and the address, never the credential.

## OpenAPI security

With `auth` on, `/openapi.json` marks every operation that needs a user with `x-auth` (its roles and scopes), its 401 and 403 responses and a line like `Requires one of the roles: editor.`, and every other operation with `security: []`. Providers add the schemes they accept with `addAuthScheme(doc, name, scheme)`, as one more alternative on every marked operation, with the operation's scopes for OAuth2 and OpenID Connect; the example adds its API key in `docs.openapi`. The build warns `auth is enabled but no provider documents a security scheme in /openapi.json` until one does.

## The account protection kit

Providers that sign users in share tested pieces against account attacks: `loginGuard()` locks an identifier after 5 failures in 15 minutes (1 minute, doubling up to 1 hour) and an address after 50, storing only hashes; `invalidCredentials()` is the one 401 for every failure; and `dummyPasswordCheck()` makes an unknown account take as long as a wrong password:

```ts
import { dummyPasswordCheck, invalidCredentials, loginGuard, type Endpoint } from "@quickservicets/core";

const guard = loginGuard();

/** @auth off */
const handler: Endpoint<{ email: string; password: string }> = async (repos, req) => {
  const { email, password } = await req.json();
  await guard.assert({ identifier: email, ip: req.ip }); // 429 Too many attempts; try again later
  const account = await repos.accounts.findOne([{ field: "email", op: "eq", value: email.trim().toLowerCase() }]);
  const ok = account ? await Bun.password.verify(password, account.passwordHash) : await dummyPasswordCheck(password);
  if (!ok) {
    await guard.fail({ identifier: email, ip: req.ip });
    throw invalidCredentials();
  }
  await guard.succeed({ identifier: email });
  return { token: await issueToken(account!) };
};

export default handler;
```

`repositoryThrottleStore(repository)` shares the counters across replicas, and `sessionStore()` keeps opaque server-side sessions with hashed tokens, a per-worker cache, idle and absolute expiry and pruning.

## CSRF for cookie sessions

The `csrf` item of `security` refuses cross-site writes that ride on a session cookie: a cookie-authenticated `POST`, `PUT`, `PATCH` or `DELETE` passes only from the service's own origin, `security.csrf.origins` or `security.cors.origins` (or with `Sec-Fetch-Site: same-origin`), and answers 403 `Cross-site request rejected` otherwise. Requests with tokens skip it. `mode: "token"` uses a double-submit cookie instead, `@csrf off` exempts a route, and `sessionCookie(name, value, { maxAge })` writes a session cookie with `HttpOnly`, `SameSite=Lax` and `Secure` in production.

## Revocation

`ctx.feature("auth").revoke({ userId })` (or `{ sessionId }`) calls `revoke` of every provider, emits `auth.session.revoked` while `events` is on, and runs the `onRevoke` callbacks, so every part of the service hears it.

## Tenancy and credentials

A provider whose credentials belong to one tenant returns `tenant: { id }`. With `tenancy: {}`, a request whose resolved tenant differs answers 403 `Tenant does not match the credentials`, and `tenancy.from: ["auth"]` takes the tenant from the credentials alone.

## Customization

Every level of the native, as the example's README shows:

- Level 0: `auth: {}` with one provider; routes stay public until tagged.
- Level 1: every option has a variable: `QS_AUTH_ENABLED`, `QS_AUTH_REQUIRED`, `QS_AUTH_SCOPES`, `QS_AUTH_ROLES`.
- Level 2: the tags `@auth`, `@roles` and `@csrf`.
- Level 3: `required` as a function of the request, its user and its tenant, decided once the tenant is known: `required: ({ tenant }) => tenant?.attributes.private === "true"`.
- Level 4: the hooks `beforeUser` (change the user, like roles from the database), `onAuthenticated`, `onAuthFailed` and `beforeAuthorize` (true allows, false answers 403), also through `ctx.feature("auth").addHook`.
- Level 5: the native has no files to override.
- Level 6: your own providers, in `providers` or registered by a feature.
- Level 7: `quickservicets eject auth` copies the native into `features/auth/`.

## Testing with testAuth()

`testAuth()` from `@quickservicets/core/testing` reads `x-test-user: <id>;roles=a,b;tenant=<id>` (and `session=`, `scopes=`); `startTestService` registers it with its `auth` option, and a service with `production: true` refuses to start with it:

```ts
const service = await startTestService({ files, auth: testAuth() });
expect((await service.fetch("/posts", { method: "POST", headers: { "x-test-user": "u1;roles=editor" }, body })).status).toBe(201);
```
