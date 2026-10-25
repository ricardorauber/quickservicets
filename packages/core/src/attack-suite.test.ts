import { test } from "bun:test";
import { memoryAdapter } from "./adapters/memory.ts";
import { mongodbAdapter } from "./adapters/mongodb.ts";
import { postgresAdapter } from "./adapters/postgres.ts";
import { sqliteAdapter } from "./adapters/sqlite.ts";
import { runAttackSuite } from "./testing/attack-suite.ts";
import { resetPostgresTables } from "./testing/postgres.ts";
import { createSqliteTables } from "./testing/sql.ts";

runAttackSuite({ name: "memory", adapter: () => memoryAdapter() });

runAttackSuite({
  name: "sqlite",
  adapter: () => {
    const adapter = sqliteAdapter({ path: ":memory:" });
    const connect = adapter.connect.bind(adapter);
    adapter.connect = async (models) => {
      await connect(models);
      await createSqliteTables(adapter.client!, models);
    };
    return adapter;
  },
});

const postgresUrl = process.env.TEST_POSTGRES_URL;
if (postgresUrl) {
  runAttackSuite({
    name: "postgres",
    adapter: () => {
      const adapter = postgresAdapter({ url: postgresUrl });
      const connect = adapter.connect.bind(adapter);
      adapter.connect = async (models) => {
        await connect(models);
        await resetPostgresTables(adapter.client!, models);
      };
      return adapter;
    },
  });
} else {
  test.skip("attack suite: postgres (set TEST_POSTGRES_URL to run)", () => {});
}

const mongodbUrl = process.env.TEST_MONGODB_URL;
if (mongodbUrl) {
  runAttackSuite({
    name: "mongodb",
    adapter: () => {
      const adapter = mongodbAdapter({ url: mongodbUrl, database: `qs_attack_${Bun.randomUUIDv7().replaceAll("-", "")}` });
      const connect = adapter.connect.bind(adapter);
      const disconnect = adapter.disconnect.bind(adapter);
      adapter.connect = async (models) => {
        await connect(models);
        for (const model of models) await adapter.createIndexes(model);
      };
      adapter.disconnect = async () => {
        await adapter.db?.dropDatabase();
        await disconnect();
      };
      return adapter;
    },
  });
} else {
  test.skip("attack suite: mongodb (set TEST_MONGODB_URL to run)", () => {});
}
