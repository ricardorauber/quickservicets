import { expect, test } from "bun:test";
import { postgresAdapter, type InfraService } from "@quickservicets/core";
import { runAdapterContract } from "@quickservicets/core/testing";
import { recordStatements, resetPostgresTables } from "../../../core/src/testing/postgres.ts";
import { describeWithServices } from "./services.ts";

/** PgBouncer in transaction mode in front of the catalog's PostgreSQL, in the same compose project. */
const pgbouncer: InfraService = {
  name: "pgbouncer",
  kind: "custom",
  description: "PgBouncer in transaction mode.",
  image: "edoburu/pgbouncer:v1.24.1-p1",
  ports: [5432],
  health: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -p 5432"],
  credentials: { user: "postgres", password: "postgres", database: "app" },
  environment: { DATABASE_URL: "postgres://postgres:postgres@postgres:5432/app", POOL_MODE: "transaction", AUTH_TYPE: "scram-sha-256", LISTEN_PORT: "5432" },
  env: { PGBOUNCER_URL: "postgres://{user}:{password}@{host}:{port}/{database}" },
  optional: false,
  owners: ["test"],
};

// Both run in containers, even when TEST_POSTGRES_URL points at a server, so PgBouncer reaches PostgreSQL by name.
describeWithServices(
  ["postgres", "pgbouncer"],
  (services) => {
    runAdapterContract("postgres through pgbouncer", async () => {
      const adapter = postgresAdapter({ url: services.urls.pgbouncer! });
      adapter.configurePool!({ prepare: false });
      const connect = adapter.connect.bind(adapter);
      adapter.connect = async (models, options) => {
        // The tables are created on the direct connection, as migrations are.
        const direct = new Bun.SQL({ url: services.urls.postgres!, max: 1 });
        try {
          await resetPostgresTables(direct, models);
        } finally {
          await direct.close();
        }
        await connect(models, options);
      };
      return adapter;
    });

    test("statements go through PgBouncer unprepared and with no SET", async () => {
      const adapter = postgresAdapter({ url: services.urls.pgbouncer! });
      adapter.configurePool!({ prepare: false });
      await adapter.connect([], {});
      try {
        const log = recordStatements(adapter.client!);
        // The same statement twice on a pooled server connection: a named prepared statement would collide.
        for (let round = 0; round < 3; round++) expect([...(await adapter.client!.unsafe("select $1::int as n", [round]))]).toEqual([{ n: round }]);
        expect(log.statements.some((statement) => /^\s*set\s/i.test(statement))).toBe(false);
        const [server] = await adapter.client!.unsafe("select current_setting('server_version') as version");
        expect(server.version).toMatch(/^17\./);
      } finally {
        await adapter.disconnect();
      }
    });
  },
  { services: [pgbouncer], env: { ...process.env, TEST_POSTGRES_URL: undefined } },
);
