---
title: Deploy targets
description: Build the same project for a long-running server, a self-contained binary, AWS Lambda, Azure Functions or Google Cloud Run with one flag.
sidebar:
  order: 64
---

The deployment platform is a build option, not a rewrite. `quickservicets build` writes `.generated/` as always, then the deployable output of one target to `dist/<target>/`, replacing what the folder held:

```bash
bun run quickservicets build --target lambda
```

```text
Built 1 entity, 0 custom endpoints and 0 hooks.
Target lambda: dist/lambda/ (1.4 MB)
```

## The targets

| Target | Output | Use it for |
| --- | --- | --- |
| `server` (default) | `dist/server/` | A long-running Bun process on a host, a VM or a container. |
| `binary` | `dist/binary/` | A self-contained executable that needs no Bun or `node_modules` on the machine. |
| `lambda` | `dist/lambda/` | AWS Lambda behind API Gateway, an Application Load Balancer or a function URL. |
| `azure-functions` | `dist/azure-functions/` | Azure Functions as a custom handler. |
| `cloud-run` | `dist/cloud-run/` | A container on Google Cloud Run. |

The target comes from `--target`, then `QS_DEPLOY_TARGET`, then `deploy.target` in the config, then `server`. An unknown name exits 1 with `Unknown deploy target <value>; use server, binary, lambda, azure-functions or cloud-run`.

## Options

The `deploy` native is enabled by default and acts only at build time; the server target behaves as `quickservicets build` always did, and nothing is added to a running service.

```ts
export default defineConfig({
  deploy: { target: "cloud-run", outDir: "build", name: "blog", platform: "linux-arm64" },
});
```

- `target`: the default target.
- `outDir`: the output folder (`dist`); each target writes `<outDir>/<target>/`.
- `name`: the name of the service and its artifacts (the package name without its scope).
- `platform`: the operating system and CPU of compiled binaries: the build machine for `server` and `binary`, `linux-arm64` for `lambda`, `linux-x64` for `azure-functions` and `cloud-run`.
- `external`: packages left out of the bundle.

Each option has its variable: `QS_DEPLOY_TARGET`, `QS_DEPLOY_OUT_DIR`, `QS_DEPLOY_NAME` and `QS_DEPLOY_PLATFORM`. `deploy: false` (or `QS_DEPLOY_ENABLED=false`) writes no output, and a target other than `server` then exits 1 with `deploy is disabled (deploy: false in quickservicets.config.ts)`.

## Bundles and binaries

The `server` target bundles the generated entry, the project's files, the enabled features and their dependencies into one minified file, `dist/server/server.js`, with its source map `server.js.map`. It needs no `node_modules`: copy `dist/server/` to a machine with Bun and run it.

```bash
bun dist/server/server.js migrate   # applies the pending migrations
bun dist/server/server.js           # serves (the same as `serve`)
```

The `binary` target compiles the same bundle with `bun build --compile` into one executable for `deploy.platform`, `dist/binary/<name>` (`<name>.exe` on Windows), that needs not even Bun on the machine. It takes the same subcommands, so a container or a release step runs migrations with the artifact it deploys:

```bash
./dist/binary/blog migrate && ./dist/binary/blog
```

Files read at runtime travel with the artifact: the `migrations/` folder, `.generated/openapi.json`, each feature's build output in `.generated/<key>/`, and the files a feature lists in its `assets` field. The bundle copies them to `dist/server/assets/` and the binary embeds them; code finds them with `assetPath(name)` from `@quickservicets/core`, which reads from the assets in a bundle or binary and from the project otherwise:

```ts
import { readdirSync } from "node:fs";
import { assetPath } from "@quickservicets/core";

const migrations = readdirSync(assetPath("migrations"));
```

`deploy.external` (`QS_DEPLOY_EXTERNAL`) leaves packages out of the bundle, to ship them next to it in `node_modules`. A module the bundler cannot include, one that does not resolve or a native addon, fails the build with `<module> cannot be bundled for server; add it to deploy.external and ship it next to the bundle`; binaries cannot load external modules, so they fail with `<module> cannot be bundled for binary; binary targets cannot load external modules; use the server target`.

The build prints the output's size and its five largest modules; `quickservicets build --analyze` also writes `dist/<target>/bundle-report.json` with the size of every bundled module.

## Lazy loading and startup time

Cold starts stay short because little is loaded before the first request:

- Importing `@quickservicets/core` loads no database driver; each adapter imports its driver when it connects.
- With `deploy.lazyRoutes` on, the generated route table holds a loader per endpoint file and imports the module on the first request matching it, keeping it afterward; methods, paths, tags and hook names stay in the table. `auto` (the default) turns it on for `lambda`, `azure-functions` and `cloud-run` and off otherwise; `on` and `off` force it (`QS_DEPLOY_LAZY_ROUTES`). An endpoint whose module fails to import answers 500 for its route only, logs `routes.load.failed` with the file, and is imported again on the next request.
- The OpenAPI document and the `/docs` page are read and built on their first request, on every target.

Once the `onStart` callbacks finish, the service logs `service.started` with `durationMs` and the time of each phase:

```json
{"message":"service.started","durationMs":41.2,"phases":{"config":3.1,"setup":12.4,"connect":8.9,"start":15.6}}
```

`QS_DEPLOY_STARTUP_TRACE=true` (`deploy.startupTrace`) adds `features`, with each feature's `setup` and `onStart` time, to find what makes a start slow.

## Function mode

On `lambda` and `azure-functions` the service runs as a function: one process per instance (`server.workers` is ignored), no job scheduler and no queue consumer loops of its own, and no WebSocket routes. The build says what the platform must drive instead:

```text
Warning: server.workers is ignored on lambda
Warning: jobs/reports/daily runs only when the platform invokes it (see the deploy guide)
Warning: queues/notify needs a platform trigger (an SQS or Service Bus trigger) to be consumed
```

A `ws.ts` route fails the build with `endpoints/<path>/ws.ts cannot run on <target>; WebSockets need a server target`.

## The platform handler

Every platform target serves requests through `createServiceHandler`, exported by `@quickservicets/core`, which takes the inputs the generated server passes to `startService` and runs each standard `Request` through the same pipeline as the server, so a route answers identically everywhere:

```ts
import { createServiceHandler } from "@quickservicets/core";

const handler = createServiceHandler({ projectConfig, models, crudRoutes, endpoints, hooks, jobs, openApi, features, featureFolders });
const response = await handler.fetch(request, { name: "lambda", requestId: "c6af9ac6-7b61", clientIp: "203.0.113.9", deadline: Date.now() + 3000 });
await handler.runJob("reports/daily");
```

- Nothing happens until `init()` or the first `fetch` or `runJob`; the config, the feature setups, the database and the `onStart` callbacks then run once per instance, even for concurrent first calls. A failed initialization logs `service.init.failed`, rejects the call and is tried again on the next one, so the platform can retry or recycle the instance.
- The platform's `requestId` becomes the request id when the request has no `x-request-id`, and `clientIp` becomes `req.ip`. `req.platform` gives `name`, the raw `event` and `context`, and `remainingMs()`.
- With a `deadline`, the request's `req.raw.signal` aborts 500 milliseconds before it, and a handler still running at the deadline answers 504 `GATEWAY_TIMEOUT` `Request exceeded the platform deadline`.
- `runJob(name, { tenant })` runs one job and records its `JobRun`, so a platform schedule drives jobs; an undeclared name rejects with `Unknown job <name>`.
- `stop()` runs the `onShutdown` and `onStop` callbacks and disconnects within `lifecycle.stopTimeout`; the handler calls it on `SIGTERM`.

## See also

- [Local environment](/guides/local-environment/): the services the project needs, on your machine.
- [deploy reference](/reference/features/deploy/): every option with its variable.
