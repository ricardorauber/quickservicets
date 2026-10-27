# auth

The smallest project that shows the `auth` native: one authentication contract for every provider. A project-written provider in `lib/api-key.ts` checks the `x-api-key` header against the `API_KEY` variable and signs in an editor; `Post` is tagged `@auth` and `@roles editor:write`, so anyone signed in reads posts and only editors write them; `GET /me` answers `requireUser(req)`; and the OpenAPI document marks every protected operation and documents the API key.

```bash
API_KEY=k-123 bun run test
```

The authentication guide (`docs/src/content/docs/guides/authentication.md`, on the site at `/guides/authentication/`) explains every piece.

## Level 0: enable

Turn the native on with at least one provider; routes stay public until a tag or `required` protects them. In tests, `testAuth()` signs in any user from the `x-test-user` header:

```ts
export default defineConfig({ database: memoryAdapter(), auth: {} });
```

```ts
const service = await startTestService({ files, auth: testAuth() });
await service.fetch("/me", { headers: { "x-test-user": "u1;roles=editor" } });
```

## Level 1: options and environment

Every option has a variable; `QS_AUTH_REQUIRED=true` makes every route need a user, except the ones tagged `@auth off`, the health probes and the API docs:

```bash
QS_AUTH_REQUIRED=true QS_AUTH_SCOPES=api bun .generated/server.ts
```

## Level 2: tags

`@auth` requires a user (and optionally token scopes), and `@roles` requires roles per operation, with the `view` and `write` groups:

```ts
/**
 * @auth
 * @roles editor:write
 */
export type Post = { title: string };
```

```ts
/** @auth scopes=posts:publish */
export default handler;
```

## Level 3: per request

`required` may be a function of the request, its user and its tenant, so a tenant's attribute decides whether its API is private:

```ts
auth: { providers: [apiKeyProvider()], required: ({ tenant }) => tenant?.attributes.private === "true" }
```

## Level 4: hooks and events

`beforeUser` changes the user after a provider's result, like roles the service keeps (or loads from its database); `beforeAuthorize`, `onAuthenticated` and `onAuthFailed` decide and observe:

```ts
auth: {
  providers: [apiKeyProvider()],
  // Roles kept by the service itself, added to the provider's.
  beforeUser: ({ user }) => ({ ...user, roles: [...(user.roles ?? []), ...(extraRoles[user.id] ?? [])] }),
  beforeAuthorize: ({ operation, user }) => (operation === "delete" && !user?.roles?.includes("admin") ? false : undefined),
}
```

## Level 5: override files

Not applicable: the native contributes no entities, endpoints, hooks, jobs or folders, so there are no files to override.

## Level 6: replace the implementation

A provider is any object with a name, the credentials it reads and an `authenticate` method; `providers` registers the project's own before the ones features add:

```ts
export function apiKeyProvider(): AuthProvider {
  return {
    name: "api-key",
    credentials: { headers: ["x-api-key"] },
    authenticate: (req) => (same(req.headers.get("x-api-key") ?? "", env.API_KEY!) ? { user: { id: "api-client", roles: ["editor"] }, method: "apiKey" } : null),
  };
}
```

## Level 7: eject

Copy the native into the project as a `features/auth/` project feature that replaces it:

```bash
quickservicets eject auth
```
