# dev

> Local services for development: `quickservicets dev --services` starts the database and every service the project's features need with Docker Compose.

Local services for development: `quickservicets dev --services` starts the database and every service the project's features need with Docker Compose.

## Enabling

Turn it on in `quickservicets.config.ts`:

```ts
dev: {}
```

It is enabled by default; turn it off with `dev: false` or `QS_DEV_ENABLED=false`.

## Options

| Key | Type | Default | Environment variable | Per request | Description |
| --- | --- | --- | --- | --- | --- |
| `dev.services.<name>.enabled` | `record of boolean` | `true` | `QS_DEV_SERVICES_<NAME>_ENABLED` | no | Starts this service; false leaves it to you. |
| `dev.services.<name>.image` | `record of string` | — | `QS_DEV_SERVICES_<NAME>_IMAGE` | no | Replaces the catalog's image of this service. |
| `dev.services.<name>.port` | `record of integer` | — | `QS_DEV_SERVICES_<NAME>_PORT` | no | The host port of the service's first container port (default: the catalog's). |
| `dev.services.<name>.env.<name>` | `record of record of string` | — | `QS_DEV_SERVICES_<NAME>_ENV_<NAME>` | no | The value of one container variable. |
| `dev.composeFile` | `string` | `".generated/dev/compose.yml"` | `QS_DEV_COMPOSE_FILE` | no | Where the generated Docker Compose file is written, relative to the project. |
| `dev.project` | `string` | — | `QS_DEV_PROJECT` | no | The Docker Compose project name (default: the package name, without its scope). |
| `dev.wait` | `duration` | `"60s"` | `QS_DEV_WAIT` | no | How long `services up` waits for every health check before failing. |
| `dev.enabled` | `boolean` | `true` | `QS_DEV_ENABLED` | no | Turns the feature off when false. |
| `dev.database` | `string` | — | `QS_DEV_DATABASE` | no | The database of the feature's own tables, `default` or a name of `databases`; tables of one entity follow it, and per-database tables exist in every database (default: the default database). |

## Commands

### `services up`

Writes the Docker Compose file of the services the project needs (its database, Redis, a broker and what its features ask for) and starts them, waiting for their health checks.

```bash
quickservicets services up
```

### `services down`

Stops and removes the local services' containers; `--volumes` also removes their data.

```bash
quickservicets services down [--volumes]
```

**Flags:**

- `--volumes` (`boolean`, default `false`): Also removes the services' named volumes.

### `services status`

Prints each local service with its container's state, health and host port.

```bash
quickservicets services status
```

### `services logs`

Prints the logs of the local services, or of one.

```bash
quickservicets services logs [name]
```

**Arguments:**

- `<name>`: The service, like `database` or `redis`.

### `services env`

Prints the connection variables of the local services, with passwords as `[secret]` unless `--show` is given.

```bash
quickservicets services env [--show]
```

**Flags:**

- `--show` (`boolean`, default `false`): Prints the passwords.
