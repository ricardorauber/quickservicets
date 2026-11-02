# secrets

The smallest project that shows the `secrets` native: no secret value is written in the configuration. The database URL comes from `DATABASE_URL` through `env://`, the payments API key from the file `secrets/api-key` through `file://`, and the partner token from `local-vault.json` through a project provider for `local://`, re-read every minute so editing the file rotates the token without a restart.

```bash
bun run seed
DATABASE_URL=postgres://app:secret@localhost:5432/app bun run quickservicets secrets check
bun run build && bun run test
```

`bun run seed` creates the git-ignored `secrets/` folder with the API key. `quickservicets secrets check` resolves every reference and prints one line each, `ok` with the version or `failed: <reason>`, never a value.

## Level 0: enable

Turn the native on and write references instead of values; `env://` and `file://` are built in:

```ts
export default defineConfig({
  database: postgresAdapter({ url: secret("env://DATABASE_URL") }),
  secrets: {},
  http: { services: { payments: { url: "https://payments.example.com", auth: { apiKey: { header: "x-api-key", value: secret("file://secrets/api-key") } } } } },
});
```

## Level 1: options and environment

`ttl` sets how long a value is kept when its provider gives none, `refresh` how often due values are checked, and every option has a `QS_SECRETS_*` variable:

```bash
QS_SECRETS_TTL=1m QS_SECRETS_REFRESH=30s bun .generated/server.ts
```

## Level 2: tags

Not applicable: secrets are configuration values, not entity, field or route options, so the native has no tags.

## Level 3: per request

A reference with `{tenant}` resolves for each request's tenant, like each tenant's own database:

```ts
tenancy: { strategy: "database", connection: secret("local://tenants/{tenant}#dsn") },
```

## Level 4: hooks and events

`beforeResolve` may return another reference, like one with the environment's name in its path; `onRotate` and `onResolveFailed` observe rotations and failures, never values:

```ts
secrets: {
  beforeResolve: ({ reference }) => (reference.startsWith("local://") ? reference.replace("local://", `local://${process.env.APP_ENV ?? "dev"}/`) : undefined),
  onRotate: ({ path, version }) => console.log(`rotated ${path} to ${version}`),
},
```

## Level 5: override files

Not applicable: the native has no endpoints, hooks or entity files to override.

## Level 6: replace the implementation

A project provider resolves its own scheme; `vault/local-vault.ts` reads `local-vault.json`:

```ts
secrets: { providers: [localVault(join(import.meta.dir, "local-vault.json"))] },
http: { services: { partner: { url: "https://partner.example.com", auth: { bearer: secret("local://partner#token") } } } },
```

## Level 7: eject

Copy the native into the project, where it replaces the built-in one:

```bash
bunx quickservicets eject secrets
```
