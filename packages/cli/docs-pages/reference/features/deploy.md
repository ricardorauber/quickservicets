# deploy

> Deploy targets: `quickservicets build --target <target>` writes the deployable output for a server, a binary, AWS Lambda, Azure Functions or Google Cloud Run.

Deploy targets: `quickservicets build --target <target>` writes the deployable output for a server, a binary, AWS Lambda, Azure Functions or Google Cloud Run.

## Enabling

Turn it on in `quickservicets.config.ts`:

```ts
deploy: {}
```

It is enabled by default; turn it off with `deploy: false` or `QS_DEPLOY_ENABLED=false`.

## Options

| Key | Type | Default | Environment variable | Per request | Description |
| --- | --- | --- | --- | --- | --- |
| `deploy.target` | `"server" \| "binary" \| "lambda" \| "azure-functions" \| "cloud-run"` | `"server"` | `QS_DEPLOY_TARGET` | no | The platform `quickservicets build` writes the deployable output for: server, binary, lambda, azure-functions or cloud-run; `--target` wins over it. |
| `deploy.outDir` | `string` | `"dist"` | `QS_DEPLOY_OUT_DIR` | no | The folder of the deployable output; each target writes `<outDir>/<target>/`. |
| `deploy.name` | `string` | — | `QS_DEPLOY_NAME` | no | The name of the deployed service and its artifacts (default: the package name without its scope). |
| `deploy.platform` | `"linux-x64" \| "linux-arm64" \| "darwin-x64" \| "darwin-arm64" \| "windows-x64"` | — | `QS_DEPLOY_PLATFORM` | no | The operating system and CPU of compiled binaries (default: the build machine for server and binary, linux-arm64 for lambda, linux-x64 for azure-functions and cloud-run). |
| `deploy.external` | `string[]` | `[]` | `QS_DEPLOY_EXTERNAL` | no | Packages left out of the bundle, to ship next to it in node_modules (server target only); a package with a native addon must be listed. |
| `deploy.lazyRoutes` | `"auto" \| "on" \| "off"` | `"auto"` | `QS_DEPLOY_LAZY_ROUTES` | no | Makes the generated route table import each endpoint module on the first request matching it: on, off, or auto (on for lambda, azure-functions and cloud-run, off otherwise). |
| `deploy.startupTrace` | `boolean` | `false` | `QS_DEPLOY_STARTUP_TRACE` | no | Adds each feature's setup and onStart time, in milliseconds, to the service.started log entry. |
| `deploy.lambda.architecture` | `"arm64" \| "x86_64"` | `"arm64"` | `QS_DEPLOY_LAMBDA_ARCHITECTURE` | no | The CPU of the Lambda function the bootstrap is compiled for (deploy.platform, when set, wins). |
| `deploy.lambda.streaming` | `boolean` | `false` | `QS_DEPLOY_LAMBDA_STREAMING` | no | Sends responses with the streaming response mode, so sse.ts routes work behind function URLs with RESPONSE_STREAM. |
| `deploy.azure.authLevel` | `"anonymous" \| "function"` | `"anonymous"` | `QS_DEPLOY_AZURE_AUTH_LEVEL` | no | The authLevel of the HTTP function: anonymous, or function to require a function key. |
| `deploy.azure.functionTimeout` | `duration` | — | `QS_DEPLOY_AZURE_FUNCTION_TIMEOUT` | no | The functionTimeout written to host.json, like 10m (default: the plan's). |
| `deploy.azure.extensionBundle` | `boolean` | `true` | `QS_DEPLOY_AZURE_EXTENSION_BUNDLE` | no | Adds the default extension bundle to host.json, so trigger bindings resolve. |
| `deploy.cloudRun.concurrency` | `integer` | `80` | `QS_DEPLOY_CLOUD_RUN_CONCURRENCY` | no | The most requests one container serves at once (containerConcurrency). |
| `deploy.cloudRun.timeout` | `duration` | `"300s"` | `QS_DEPLOY_CLOUD_RUN_TIMEOUT` | no | How long a request may take before Cloud Run ends it (timeoutSeconds). |
| `deploy.cloudRun.minInstances` | `integer` | `0` | `QS_DEPLOY_CLOUD_RUN_MIN_INSTANCES` | no | The fewest containers kept running (autoscaling.knative.dev/minScale). |
| `deploy.cloudRun.maxInstances` | `integer` | `100` | `QS_DEPLOY_CLOUD_RUN_MAX_INSTANCES` | no | The most containers Cloud Run starts (autoscaling.knative.dev/maxScale). |
| `deploy.cloudRun.cpuAlwaysAllocated` | `boolean` | `false` | `QS_DEPLOY_CLOUD_RUN_CPU_ALWAYS_ALLOCATED` | no | Keeps the CPU allocated outside requests, so the job scheduler and queue consumers run (run.googleapis.com/cpu-throttling: false). |
| `deploy.cloudRun.memory` | `string` | `"512Mi"` | `QS_DEPLOY_CLOUD_RUN_MEMORY` | no | The memory limit of the container. |
| `deploy.cloudRun.cpu` | `string` | `"1"` | `QS_DEPLOY_CLOUD_RUN_CPU` | no | The CPU limit of the container. |
| `deploy.cloudRun.trustProxy` | `boolean` | `true` | `QS_DEPLOY_CLOUD_RUN_TRUST_PROXY` | no | Takes req.ip from the x-forwarded-for entry Google's front end adds, without listing proxy ranges in security.proxy.trust. |
| `deploy.targets.<name>` | `record of DeployTarget` | — | not overridable | no | A target's build function. |
| `deploy.beforeBundle` | `hook` | — | not overridable | no | Runs before a target is bundled, with its target, entrypoints, external packages and define replacements; returning them changed changes the bundle. |
| `deploy.afterBundle` | `hook` | — | not overridable | no | Runs after a target's output is written, with its files and their sizes. |
| `deploy.onPlatformEvent` | `hook` | — | not overridable | no | Runs for every non-HTTP event a platform delivers (a Lambda event, an Azure invocation) before it is dispatched; returning a result answers the event. |
| `deploy.enabled` | `boolean` | `true` | `QS_DEPLOY_ENABLED` | no | Turns the feature off when false. |
| `deploy.database` | `string` | — | `QS_DEPLOY_DATABASE` | no | The database of the feature's own tables, `default` or a name of `databases`; tables of one entity follow it, and per-database tables exist in every database (default: the default database). |

## Tags

### `@preload`

Imports the routes' modules at startup even with lazy routes (deploy.lazyRoutes), for routes that must answer the first request fast.

**Applies to:** entities, endpoints

**Syntax:** `@preload` or `@preload off`

**Options:** none

```ts
/** @preload */
export type Post = { title: string };
```

## Hooks

Hooks are functions (or lists of functions) written in the config; `before` hooks may change the value or cancel the step by throwing, `after` and `on` hooks observe.

| Hook | Kind | Description |
| --- | --- | --- |
| `deploy.beforeBundle` | before | Runs before a target is bundled, with its target, entrypoints, external packages and define replacements; returning them changed changes the bundle. |
| `deploy.afterBundle` | after | Runs after a target's output is written, with its files and their sizes. |
| `deploy.onPlatformEvent` | on | Runs for every non-HTTP event a platform delivers (a Lambda event, an Azure invocation) before it is dispatched; returning a result answers the event. |

## Feature API

Other features reach it with `ctx.feature("deploy")` in their setup, listing `deploy` in `requires` or `after`.

### `target`

```ts
target(name: string, target: DeployTarget): void;
```

Adds a deploy target the build accepts with `--target <name>`.

### `addHook`

```ts
addHook(name: "beforeBundle", fn: FeatureHook<BundleInput, undefined>): void;
```

### `addHook`

```ts
addHook(name: "afterBundle", fn: FeatureHook<BundleOutput, undefined>): void;
```

### `addHook`

```ts
addHook(name: "onPlatformEvent", fn: FeatureHook<PlatformEvent, undefined>): void;
```

## Targets and their output

| Target | Output in `<outDir>/<target>/` |
| --- | --- |
| `server` | `server.js`, `server.js.map` and `assets/` |
| `binary` | the executable `<name>` (`<name>.exe` on Windows) |
| `lambda` | `bootstrap` and `function.zip` |
| `azure-functions` | the executable, `host.json`, `http/function.json` and `job-<name>/function.json` per job |
| `cloud-run` | the executable, `Dockerfile`, `.dockerignore` and `service.yaml` |

## Override files

A project file `deploy/<target>/entry.ts` replaces the generated entry of that target (the bundle's entry for `server`, the platform entry of the others), and any other file in `deploy/<target>/` replaces the generated file of the same name, like `deploy/azure-functions/host.json`, `deploy/cloud-run/service.yaml` or `deploy/cloud-run/Dockerfile`. Each one prints `Override: deploy/<target>/<name> replaces the generated <name>`.

## The DeployTarget contract

`targets` and `ctx.feature("deploy").target(name, target)` (for features listing `deploy` in `requires` or `after`) add targets for `--target <name>`. The build first bundles the service into `<outDir>/<name>/` (`server.js` and `assets/`), then calls the target:

```ts
interface DeployTarget {
  build(context: { bundle: string; outDir: string; options: DeployOptions; log(line: string): void }): void | Promise<void>;
}
```

A name equal to a built-in target, or registered twice, fails naming both owners.
