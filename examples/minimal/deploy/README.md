# deploy

The smallest project that shows the `deploy` native: one project, a `Post` entity on SQLite with `health`, a daily job `reports/daily` and an `sse.ts` route, builds for every deploy target with one flag:

```bash
bun run build:server     # dist/server/: server.js, its source map and assets
bun run build:binary     # dist/binary/minimal-deploy
bun run build:lambda     # dist/lambda/: bootstrap and function.zip
bun run build:azure      # dist/azure-functions/: the custom handler app
bun run build:cloud-run  # dist/cloud-run/: the binary, Dockerfile and service.yaml
```

`bun run test` builds each target into a temporary folder and runs it locally, without cloud accounts or Docker: the bundle and the binary answer `GET /posts`, the Lambda bootstrap answers payload 1.0 and 2.0 events and a job event against a fake Runtime API, the Azure binary answers a forwarded request and a timer invocation, and the Cloud Run manifest and Dockerfile carry the configured values.

## Level 0: enable

The native is enabled by default; `--target` chooses the platform:

```bash
bun run quickservicets build --target lambda
```

## Level 1: options and environment

Every option has a `QS_DEPLOY_*` variable; the flag wins over the variable, which wins over the config:

```ts
deploy: {
  cloudRun: { concurrency: 40, minInstances: 1 },
},
```

```bash
QS_DEPLOY_TARGET=cloud-run QS_DEPLOY_CLOUD_RUN_CONCURRENCY=10 bun run build
```

## Level 2: tags

`@preload` makes the routes of an entity or endpoint import their modules at startup even with lazy routes, for routes that must answer the first request fast:

```ts
/** @preload */
export type Post = { title: string; body?: string };
```

## Level 3: per request

Not applicable: targets are chosen at build time, before any request.

## Level 4: hooks and events

`onPlatformEvent` sees every non-HTTP event a platform delivers and may answer it, here a Lambda warm-up ping; `beforeBundle` and `afterBundle` run around each bundle:

```ts
deploy: {
  onPlatformEvent: ({ event }) => ((event as { warmup?: boolean }).warmup ? { warmed: true } : undefined),
  afterBundle: ({ target, sizes }) => console.log(target, sizes),
},
```

## Level 5: override files

A file in `deploy/<target>/` replaces the generated file of the same name, like a Dockerfile with a different base:

```text
deploy/cloud-run/Dockerfile   # replaces dist/cloud-run/Dockerfile
deploy/lambda/entry.ts        # replaces the bootstrap's entry
```

## Level 6: replace the implementation

A project target builds with `--target zip`, starting from the bundled service:

```ts
deploy: {
  targets: {
    zip: {
      async build({ bundle, outDir, log }) {
        await Bun.write(`${outDir}/service.gz`, Bun.gzipSync(await Bun.file(bundle).bytes()));
        log("zip: service.gz");
      },
    },
  },
},
```

## Level 7: eject

```bash
bun run quickservicets eject deploy
```

It copies the native into `features/deploy/`, where the project owns its targets.
