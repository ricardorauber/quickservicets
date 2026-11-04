# deploy

The smallest project that shows the `deploy` native: the same project builds for a long-running server, a self-contained binary, AWS Lambda, Azure Functions or Google Cloud Run with one flag.

```bash
bun run build:server     # dist/server/
bun run build:lambda     # dist/lambda/
```

Each build writes `.generated/` as always, then the target's deployable output to `dist/<target>/`, and prints `Target <target>: dist/<target>/ (<size>)`.

## Level 0: enable

The native is enabled by default; `--target` chooses the platform:

```bash
bun run quickservicets build --target lambda
```

## Level 1: options and environment

The target, the output folder, the service name and the platform are options, and each one has a `QS_DEPLOY_*` variable; the flag wins over the variable, which wins over the config:

```ts
export default defineConfig({
  database: sqliteAdapter({ path: process.env.DATABASE_PATH ?? "data.db" }),
  deploy: { target: "cloud-run", outDir: "build", name: "blog" },
});
```

```bash
QS_DEPLOY_TARGET=lambda bun run build
```

## Level 2: tags

Not applicable: targets are chosen at build time for the whole project.

## Level 3: per request

Not applicable: targets are chosen at build time, before any request.

## Level 4: hooks and events

Not applicable: the native has no hooks yet.

## Level 5: override files

Not applicable: the native has no files to override yet.

## Level 6: replace the implementation

Not applicable: the built-in targets cannot be replaced yet.

## Level 7: eject

```bash
bun run quickservicets eject deploy
```

It copies the native into `features/deploy/`, where the project owns its options.
