# Deploy targets

> Build the same project for a long-running server, a self-contained binary, AWS Lambda, Azure Functions or Google Cloud Run with one flag.

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

Each option has its variable: `QS_DEPLOY_TARGET`, `QS_DEPLOY_OUT_DIR`, `QS_DEPLOY_NAME` and `QS_DEPLOY_PLATFORM`. `deploy: false` (or `QS_DEPLOY_ENABLED=false`) writes no output, and a target other than `server` then exits 1 with `deploy is disabled (deploy: false in quickservicets.config.ts)`.

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
