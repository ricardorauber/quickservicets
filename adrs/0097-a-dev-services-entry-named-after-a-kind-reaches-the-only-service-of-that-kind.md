# 0097 - A `dev.services` entry named after a kind reaches the only service of that kind, and MinIO runs the Bitnami image

- Date: 2026-11-04
- Spec: 0309-dev-services-customization-example-and-guide
- Status: accepted

## Context
Spec 0306 R8 names the default database service `database`, while spec 0309 R1 and R5 configure it as `services.postgres.port` and `QS_DEV_SERVICES_POSTGRES_PORT`. Separately, the example's end-to-end test needs MinIO, and the `minio/minio` images can no longer be pulled from Docker Hub or quay.io without an account, so a catalog entry pointing at them fails on every machine.

## Options considered
- A: An entry applies to the service of its name, or else to the only service of that kind (`services.postgres` reaches `database` on PostgreSQL); with two services of one kind, only names work. For MinIO, pin Bitnami's archived build `bitnamilegacy/minio:2025.1.20`, which ships `mc` for the bucket-creating health check. Both spec forms work, and the catalog stays pullable.
- B: Rename the default database service `postgres`. Breaks spec 0306 R8 and the named databases' `database-<name>` pattern.
- C: Keep the unpullable image. Every MinIO service would fail to start.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
- `serviceSetting` in the `dev` native resolves entries by name, then by a unique kind; the guide and the reference page say so.
- The `minio` catalog kind uses `bitnamilegacy/minio:2025.1.20` with its data in `/bitnami/minio/data`.
