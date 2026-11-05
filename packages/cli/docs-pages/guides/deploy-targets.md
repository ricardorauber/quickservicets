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

## Cold starts

`bun benchmarks/run.ts cold-start` measures the milliseconds from process start to the first answer on each target, for a small SQLite service; the committed result in `benchmarks/results/cold-start.json` was measured on an Apple M1 Max:

| Target | p50 | p90 | Artifact |
| --- | --- | --- | --- |
| `server` (`bun server/server.js`) | 72 ms | 76 ms | 4.5 MB |
| `binary` | 69 ms | 85 ms | 60 MB |
| `lambda` (`bootstrap` against a local Runtime API) | 68 ms | 77 ms | 26 MB `function.zip` |

To keep cold starts low: leave lazy routes on for function and Cloud Run targets, tag only the routes that must answer the first request fast with `@preload`, keep heavy work out of feature setups and `onStart` (startup logs `service.started` with the time of each phase, and `QS_DEPLOY_STARTUP_TRACE=true` adds each feature's), and prefer the binary targets, which skip resolving and parsing `node_modules`.

## Lazy loading and startup time

Cold starts stay short because little is loaded before the first request:

- Importing `@quickservicets/core` loads no database driver; each adapter imports its driver when it connects.
- With `deploy.lazyRoutes` on, the generated route table holds a loader per endpoint file and imports the module on the first request matching it, keeping it afterward; methods, paths, tags and hook names stay in the table. `@preload` on an endpoint, or on an entity whose routes an endpoint replaces, imports it at startup anyway. `auto` (the default) turns it on for `lambda`, `azure-functions` and `cloud-run` and off otherwise; `on` and `off` force it (`QS_DEPLOY_LAZY_ROUTES`). An endpoint whose module fails to import answers 500 for its route only, logs `routes.load.failed` with the file, and is imported again on the next request.
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

Many function instances each open their own database connections; the `connections` native gives them small, lazy pools on these targets, and [Serverless connections](/guides/serverless-connections/) explains the budget, connection proxies and HTTP drivers.

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

## AWS Lambda

`--target lambda` compiles the service into an executable named `bootstrap` for `deploy.lambda.architecture` (`arm64` by default, or `x86_64`; `QS_DEPLOY_LAMBDA_ARCHITECTURE`) and packages it as `dist/lambda/function.zip`, for the `provided.al2023` runtime with no layer. The bootstrap implements the Lambda Runtime API: it initializes the service once (reporting a failure to the init error endpoint), then takes each invocation and answers it through the platform handler, with the AWS request id and the invocation's deadline.

- API Gateway REST APIs and Application Load Balancers send payload 1.0 events, HTTP APIs and function URLs payload 2.0; both become a standard `Request` (`multiValueHeaders`, multi-value query parameters and base64 bodies included) and the response goes back in the event's format, with `cookies` for 2.0 and `multiValueHeaders` for 1.0 events that sent them. Bodies other than text, JSON, XML and form data are base64 with `isBase64Encoded: true`. The client address comes from `requestContext.identity.sourceIp`, `requestContext.http.sourceIp`, or the right-most `x-forwarded-for` entry behind an ALB.
- `{ "quickservicets": { "job": "reports/daily" } }` runs that job and returns `{ "status": "completed" }`, so an EventBridge schedule drives each job. With the `triggers` native, other events go to the [trigger files](/guides/cloud-triggers/#function-targets) whose source recognizes them; any other event fails with `Unsupported Lambda event`.
- Buffered responses are limited to 6 MB: a larger one becomes 500 `INTERNAL_ERROR` `Response is larger than the 6 MB Lambda limit`, logged as `lambda.response.too-large` with the route.
- `deploy.lambda.streaming: true` sends responses with the streaming response mode, so `sse.ts` routes work behind a function URL with `InvokeMode: RESPONSE_STREAM`; without it the build warns `sse.ts routes need deploy.lambda.streaming: true on lambda`.

Deploy `function.zip` as a function on `provided.al2023` with the handler `bootstrap`, then put it behind a function URL or API Gateway:

```bash
aws lambda create-function --function-name blog --runtime provided.al2023 --architectures arm64 \
  --handler bootstrap --zip-file fileb://dist/lambda/function.zip --role arn:aws:iam::123456789012:role/blog
aws lambda create-function-url-config --function-name blog --auth-type NONE
aws lambda update-function-code --function-name blog --zip-file fileb://dist/lambda/function.zip   # each release
```

Run the migrations from a machine or a CI step that reaches the database, with the server bundle or the binary (`migrate`), before shifting traffic. Setting `deploy.platform` (like `darwin-arm64`) compiles the bootstrap for another machine, so it runs against a local Runtime API.

## Azure Functions

`--target azure-functions` writes a [custom handler](https://learn.microsoft.com/azure/azure-functions/functions-custom-handlers) app in `dist/azure-functions/`: the service compiled for `linux-x64`, a `host.json` declaring it as the custom handler with `enableForwardingHttpRequest: true` and an empty `extensions.http.routePrefix`, and `http/function.json`, an HTTP trigger on `{*path}` for every method with `authLevel` from `deploy.azure.authLevel` (`anonymous`, or `function` to require a function key).

- The binary listens on `FUNCTIONS_CUSTOMHANDLER_PORT` (or `PORT`) and serves the requests the Functions host forwards through the platform handler, with `x-ms-invocation-id` as the request id. The host runs on loopback, so the client address comes from its `x-forwarded-for`.
- Each job with a cron schedule gets a timer function, `job-<name with / as ->/function.json`, with the cron as a six-field NCRONTAB (`0 6 * * *` becomes `0 0 6 * * *`; presets and intervals that divide a minute, an hour or a day convert too). Its invocation arrives as `POST /job-<name>` with `{ Data, Metadata }`, runs the job and answers `{ Outputs: {}, Logs: [...], ReturnValue }`; a failing job answers 500 with the error in `Logs`, so the host records it and applies its retry policy. An interval like `every 7m` fails the build with `jobs/<name>: every 7m cannot be expressed as a cron for Azure Functions; use a cron schedule`.
- A route whose path is a generated function name fails the build with `Route /<name> collides with the Azure function <name>; rename the route`.
- `deploy.azure.functionTimeout` (like `10m`) is written to `host.json` as `00:10:00`, and `deploy.azure.extensionBundle` (on by default) adds the default extension bundle so trigger bindings resolve.

Publish the folder with `func azure functionapp publish <app> --custom` (Core Tools), or zip it for a run-from-package deployment.

## Google Cloud Run

`--target cloud-run` writes `dist/cloud-run/` with the service compiled for `linux-x64`, a `Dockerfile` that copies it into `gcr.io/distroless/cc-debian12` as the non-root user 10001 with `ENTRYPOINT ["/app/<name>"]`, a `.dockerignore`, and a Knative `service.yaml` named after `deploy.name`:

```ts
deploy: {
  cloudRun: { concurrency: 40, timeout: "60s", minInstances: 1, maxInstances: 20, cpuAlwaysAllocated: false, memory: "1Gi", cpu: "2" },
},
```

- `concurrency`, `timeout`, `minInstances`, `maxInstances`, `memory` and `cpu` become `containerConcurrency`, `timeoutSeconds`, the scaling annotations and the container's limits; each has a variable, like `QS_DEPLOY_CLOUD_RUN_CONCURRENCY`. With `health` on, the manifest adds a startup probe and a liveness probe on the live route.
- The service listens on `PORT`. Cloud Run stops containers 10 seconds after SIGTERM, so when the project sets neither, the service stops within 8 seconds and the health routes drain for 1 second; a longer `lifecycle.stopTimeout` plus `health.drainDelay` than 9 seconds makes the build warn `Cloud Run stops containers 10 seconds after SIGTERM; lower lifecycle.stopTimeout or health.drainDelay`.
- With `cpuAlwaysAllocated: false` (the default, `run.googleapis.com/cpu-throttling: "true"`), the CPU is throttled outside requests, so the service starts no job scheduler or queue consumer loops and the build warns `Background work needs deploy.cloudRun.cpuAlwaysAllocated: true on cloud-run` when the project has jobs or database queues; with `true` they run as on a server.
- `req.ip` is the address Google's front end adds to `x-forwarded-for`, without listing proxy ranges; `deploy.cloudRun.trustProxy: false` uses the peer address instead.

Build and push the image, set it in `service.yaml`, then deploy:

```bash
cd dist/cloud-run
docker build -t REGION-docker.pkg.dev/PROJECT/REPOSITORY/blog .
docker push REGION-docker.pkg.dev/PROJECT/REPOSITORY/blog
gcloud run services replace service.yaml
```

The same runtime stage comes from `dockerfile({ artifact, base, user, port, entrypoint, buildStage, healthcheck })` of `@quickservicets/core`, which every generator that packages the service as an image uses: `base` is `distroless` for a binary or `bun-slim` for a bundle, `buildStage` adds a stage that builds the artifact from the sources first, and `healthcheck` adds a `HEALTHCHECK`.

## Customization levels

The [example project](https://github.com/ricardorauber/quickservicets/blob/main/examples/minimal/deploy/README.md) shows each level:

1. **Enable**: nothing to write; `quickservicets build --target lambda` works without a `deploy` key.
2. **Options and environment**: `deploy.cloudRun.concurrency`, `deploy.lambda.streaming`, `deploy.azure.functionTimeout` and the rest, each with a `QS_DEPLOY_*` variable like `QS_DEPLOY_TARGET`.
3. **Tags**: `@preload` on an entity or endpoint.
4. **Per request**: not applicable; targets are chosen at build time.
5. **Hooks and events**: `beforeBundle` changes the entrypoints, external packages or `define` replacements of a bundle, `afterBundle` receives the files and their sizes, and `onPlatformEvent` sees every non-HTTP platform event first and may answer it (a Lambda warm-up ping); features add them with `ctx.feature("deploy").addHook`.
6. **Override files**: `deploy/<target>/entry.ts` replaces the target's generated entry, and any other file in `deploy/<target>/` (`Dockerfile`, `service.yaml`, `host.json`) replaces the generated one of the same name, each printing `Override: deploy/<target>/<name> replaces the generated <name>`.
7. **Replace the implementation**: `deploy.targets` (or `ctx.feature("deploy").target(name, target)` from a feature) adds targets for `--target <name>`, whose `build({ bundle, outDir, options, log })` writes the output from the bundled service.
8. **Eject**: `quickservicets eject deploy` copies the native into `features/deploy/`.

## See also

- [Local environment](/guides/local-environment/): the services the project needs, on your machine.
- [Serverless connections](/guides/serverless-connections/): database connections on servers, functions, proxies and HTTP drivers.
- [deploy reference](/reference/features/deploy/): every option with its variable.
