# auth

The smallest project that shows the `auth` native: one authentication contract for every provider. A project-written provider in `lib/api-key.ts` checks the `x-api-key` header against the `API_KEY` variable, a project feature registers it, and `GET /me` answers the signed-in user from `req.user`.

```bash
API_KEY=k-123 bun run test
```

## Level 0: enable

Turn the native on; requests without credentials stay anonymous, and in tests `testAuth()` signs in any user from the `x-test-user` header:

```ts
export default defineConfig({ database: memoryAdapter(), auth: {} });
```

```ts
const service = await startTestService({ files, auth: testAuth() });
await service.fetch("/me", { headers: { "x-test-user": "u1;roles=admin" } });
```

## Level 1: options and environment

`QS_AUTH_ENABLED=false` turns the native off without changing the config:

```bash
QS_AUTH_ENABLED=false bun .generated/server.ts
```

## Level 2: tags

Not applicable: the `@auth` and `@roles` tags come with a later version of this example.

## Level 3: per request

Not applicable: every request is authenticated by the providers that own the credentials it carries.

## Level 4: hooks and events

Not applicable: the hooks around authentication come with a later version of this example.

## Level 5: override files

Not applicable: the native has no files to override.

## Level 6: replace the implementation

A provider is any object with a name, the credentials it reads and an `authenticate` method; a project feature registers it:

```ts
export default defineFeature({
  key: "api-key",
  enabledByDefault: true,
  requires: ["auth"],
  setup: (ctx) => ctx.feature("auth").provider(apiKeyProvider()),
});
```

## Level 7: eject

Copy the native into the project as a `features/auth/` project feature that replaces it:

```bash
quickservicets eject auth
```
