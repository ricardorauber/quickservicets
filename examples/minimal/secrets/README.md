# secrets

The smallest project that shows the `secrets` native: `API_KEY` holds a reference to a file instead of the key itself, and the service reads the key from it when it starts.

```bash
mkdir -p secrets && printf 'my-api-key' > secrets/api-key
API_KEY=file://secrets/api-key bun run build && bun run test
```

## Level 0: enable

Turn the native on and declare the variable as a secret; a value like `file:///run/secrets/api-key` or `env://OTHER_NAME` is then a reference:

```ts
export default defineConfig({ secrets: {}, env: { API_KEY: secret().optional() } });
```

## Level 1: options and environment

`timeout` and `retries` bound how long resolving each reference may take at startup, and each option has a `QS_*` variable:

```bash
QS_SECRETS_TIMEOUT=5s QS_SECRETS_RETRIES=1 bun .generated/server.ts
```

## Level 2: tags

Not applicable: secrets are configuration values, not entity, field or route options, so the native has no tags.

## Level 3: per request

Not applicable: references resolve once at startup.

## Level 4: hooks and events

Not applicable: the native has no hooks yet.

## Level 5: override files

Not applicable: the native has no files to override.

## Level 6: replace the implementation

A feature that requires `secrets` registers a provider for its own scheme during its setup:

```ts
setup: (ctx) => ctx.feature("secrets").provider({ schemes: ["local"], resolve: (reference) => ({ value: lookup(reference.path) }) });
```

## Level 7: eject

Copy the native into the project, where it replaces the built-in one:

```bash
bunx quickservicets eject secrets
```
