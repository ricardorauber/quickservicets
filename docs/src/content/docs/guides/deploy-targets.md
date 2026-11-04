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

Each option has its variable: `QS_DEPLOY_TARGET`, `QS_DEPLOY_OUT_DIR`, `QS_DEPLOY_NAME` and `QS_DEPLOY_PLATFORM`. `deploy: false` (or `QS_DEPLOY_ENABLED=false`) writes no output, and a target other than `server` then exits 1 with `deploy is disabled (deploy: false in quickservicets.config.ts)`.

## Function mode

On `lambda` and `azure-functions` the service runs as a function: one process per instance (`server.workers` is ignored), no job scheduler and no queue consumer loops of its own, and no WebSocket routes. The build says what the platform must drive instead:

```text
Warning: server.workers is ignored on lambda
Warning: jobs/reports/daily runs only when the platform invokes it (see the deploy guide)
Warning: queues/notify needs a platform trigger (an SQS or Service Bus trigger) to be consumed
```

A `ws.ts` route fails the build with `endpoints/<path>/ws.ts cannot run on <target>; WebSockets need a server target`.

## See also

- [Local environment](/guides/local-environment/): the services the project needs, on your machine.
- [deploy reference](/reference/features/deploy/): every option with its variable.
