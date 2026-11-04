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
| `deploy.enabled` | `boolean` | `true` | `QS_DEPLOY_ENABLED` | no | Turns the feature off when false. |
| `deploy.database` | `string` | — | `QS_DEPLOY_DATABASE` | no | The database of the feature's own tables, `default` or a name of `databases`; tables of one entity follow it, and per-database tables exist in every database (default: the default database). |
