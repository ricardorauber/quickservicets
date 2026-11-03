import { SQL } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { createRepositories, memoryAdapter, mongodbAdapter, postgresAdapter, resolveConfig, sqliteAdapter, type DatabaseAdapter, type EntityModel, type ServiceConfig } from "@quickservicets/core";
import { EntityStatements } from "../../../core/src/adapters/postgres-statements.ts";
import { buildDrizzleSchema } from "../../../core/src/sql/schema.ts";
import { postgresDdl } from "../../../core/src/testing/postgres.ts";
import { createSqliteTables } from "../../../core/src/testing/sql.ts";
import { configureVectors, DEFAULT_MAX_SCAN, vectorDistance } from "../../../core/src/vectors.ts";
import { parseEntities } from "../entities/parse-entities.ts";
import { createProject } from "../testing/project.ts";

const CHUNK = `export type Chunk = {
  text: string;
  document?: string;
  /** @vector 3 */
  embedding?: number[];
  /** @vector 3 metric=l2 index=hnsw */
  near?: number[];
  /** @vector 3 metric=ip */
  score?: number[];
};
`;
const models: EntityModel[] = parseEntities(createProject({ "entities/Chunk.ts": CHUNK }));
const ROWS = [
  { text: "a", document: "d1", embedding: [1, 0, 0], near: [1, 0, 0], score: [1, 0, 0] },
  { text: "b", document: "d1", embedding: [0.9, 0.1, 0], near: [0.9, 0.1, 0], score: [3, 0, 0] },
  { text: "c", document: "d2", embedding: [0, 1, 0], near: [0, 1, 0], score: [0, 1, 0] },
  { text: "d", document: "d2", embedding: [0.7, 0.7, 0.1], near: [0.7, 0.7, 0.1], score: [2, 0, 0] },
  { text: "e", document: "d1", embedding: [-1, 0, 0], near: [-1, 0, 0], score: [-1, 0, 0] },
];

type Chunk = { id: string; text: string; document?: string; embedding?: number[]; distance: number };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Repos = { chunks: any };

const cleanups: (() => Promise<unknown>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  configureVectors({ maxScan: DEFAULT_MAX_SCAN });
});

async function seeded(adapter: DatabaseAdapter): Promise<Repos> {
  const repos = createRepositories(models, adapter) as unknown as Repos;
  for (const row of ROWS) await repos.chunks.create(row);
  return repos;
}

const postgresUrl = process.env.TEST_POSTGRES_URL;
/** A database of its own for these tests, dropped afterwards, when the server has pgvector. */
const postgres = postgresUrl
  ? await (async () => {
      const admin = new SQL(postgresUrl);
      try {
        if ((await admin`select 1 from pg_available_extensions where name = 'vector'`).length === 0) return undefined;
        await admin.unsafe("drop database if exists qs_b12_nearest with (force)");
        await admin.unsafe("create database qs_b12_nearest");
      } finally {
        await admin.close();
      }
      const url = new URL(postgresUrl);
      url.pathname = "/qs_b12_nearest";
      return url.toString();
    })()
  : undefined;

const adapters: [string, () => Promise<DatabaseAdapter>][] = [
  ["memory", async () => {
    const adapter = memoryAdapter();
    await adapter.connect(models);
    return adapter;
  }],
  ["sqlite", async () => {
    const adapter = sqliteAdapter({ path: ":memory:" });
    await adapter.connect(models);
    await createSqliteTables((adapter as unknown as { client: never }).client, models);
    return adapter;
  }],
  ...(process.env.TEST_MONGODB_URL
    ? ([
        ["mongodb", async () => {
          const adapter = mongodbAdapter({ url: process.env.TEST_MONGODB_URL!, database: "qs_b12_nearest" });
          await adapter.connect(models);
          const db = (adapter as unknown as { db: { dropDatabase(): Promise<unknown> } }).db;
          await db.dropDatabase();
          cleanups.push(async () => {
            await (adapter as unknown as { db: { dropDatabase(): Promise<unknown> } }).db.dropDatabase();
            await adapter.disconnect();
          });
          return adapter;
        }],
      ] as [string, () => Promise<DatabaseAdapter>][])
    : []),
  ...(postgres
    ? ([
        ["postgres", async () => {
          const adapter = postgresAdapter({ url: postgres });
          await adapter.connect(models);
          // Each test starts from empty tables, as the other adapters do.
          await adapter.client!.unsafe("drop schema if exists public cascade; create schema public; create extension if not exists vector");
          // quickservicets-allow-unsafe: runs the DDL drizzle-kit generates from the models
          for (const statement of await postgresDdl(models)) await adapter.client!.unsafe(statement);
          cleanups.push(async () => {
            await adapter.disconnect();
            const admin = new SQL(postgresUrl!);
            await admin.unsafe("drop database if exists qs_b12_nearest with (force)");
            await admin.close();
          });
          return adapter;
        }],
      ] as [string, () => Promise<DatabaseAdapter>][])
    : []),
];

const results = new Map<string, Chunk[]>();

describe.each(adapters)("nearest on %s", (name, open) => {
  test("the two closest by cosine distance, with distances; filters, select and limit", async () => {
    const repos = await seeded(await open());
    const found = (await repos.chunks.query().nearest((c: { embedding: unknown }) => c.embedding, [1, 0, 0]).take(2).toArray()) as Chunk[];
    expect(found.map((chunk) => chunk.text)).toEqual(["a", "b"]);
    expect(found[0]!.distance).toBeCloseTo(0, 6);
    expect(found[1]!.distance).toBeCloseTo(vectorDistance("cosine", [1, 0, 0], [0.9, 0.1, 0]), 6);
    results.set(name, found);
    const filtered = (await repos.chunks.where((c: { document: { eq(value: string): unknown } }) => c.document.eq("d2")).nearest("embedding", [1, 0, 0]).take(3).select("id", "text").toArray()) as Chunk[];
    expect(filtered.map((chunk) => chunk.text)).toEqual(["d", "c"]);
    expect(Object.keys(filtered[0]!).sort()).toEqual(["distance", "id", "text"]);
    expect(((await repos.chunks.query().nearest("embedding", [1, 0, 0]).limit(2).toArray()) as Chunk[]).map((chunk) => chunk.text)).toEqual(["a", "b"]);
    const l2 = (await repos.chunks.query().nearest("near", [1, 0, 0]).take(1).toArray()) as Chunk[];
    expect(l2[0]!.distance).toBeCloseTo(0, 6);
    // The inner product ranks the largest product first, with negated distances.
    const ip = (await repos.chunks.query().nearest("score", [1, 0, 0]).take(3).toArray()) as Chunk[];
    expect(ip.map((chunk) => [chunk.text, chunk.distance])).toEqual([
      ["b", -3],
      ["d", -2],
      ["a", -1],
    ]);
  });

  test("errors: take, the vector length, a field that is not a vector, orderBy", async () => {
    const repos = await seeded(await open());
    const query = () => repos.chunks.query();
    await expect(query().nearest("embedding", [1, 0, 0]).toArray()).rejects.toThrow("nearest() needs take(k) with k from 1 to 100");
    await expect(query().nearest("embedding", [1, 0, 0]).take(101).toArray()).rejects.toThrow("nearest() needs take(k) with k from 1 to 100");
    expect(() => query().nearest("embedding", [1, 0])).toThrow("nearest() needs a vector of 3 numbers for Chunk.embedding");
    expect(() => query().nearest("text", [1, 0, 0])).toThrow("Chunk.text is not a vector field");
    expect(() => query().nearest("embedding", [1, 0, 0]).orderBy((c: { text: unknown }) => c.text)).toThrow("nearest() cannot be combined with orderBy");
    expect(await query().nearest("embedding", [1, 0, 0]).take(2).count()).toBe(5);
  });
});

test("every adapter ranks alike, within 1e-6", () => {
  const reference = results.get("memory")!;
  for (const [name, found] of results) {
    expect(found.map((chunk) => chunk.text)).toEqual(reference.map((chunk) => chunk.text));
    found.forEach((chunk, index) => expect(Math.abs(chunk.distance - reference[index]!.distance), name).toBeLessThan(1e-6));
  }
});

describe("PostgreSQL statements", () => {
  test("one parameterized statement ordering by the metric's operator with a limit", async () => {
    const schema = buildDrizzleSchema(models, "postgres");
    const statements = new EntityStatements(models[0]!, schema);
    const l2 = statements.nearest([], "near", [1, 0, 0], "l2", 2);
    expect(l2.text).toContain('<-> $1::vector');
    expect(l2.text).toMatch(/limit \$2$/);
    expect(l2.params).toEqual(["[1,0,0]", 2]);
    expect(statements.nearest([], "embedding", [1, 0, 0], "cosine", 2).text).toContain("<=>");
    expect(statements.nearest([], "score", [1, 0, 0], "ip", 2).text).toContain("<#>");
  });

  if (postgres) {
    test("EXPLAIN shows the HNSW index for an l2 field with the index", async () => {
      const adapter = (await adapters.find(([name]) => name === "postgres")![1]()) as DatabaseAdapter & { client: SQL };
      const schema = buildDrizzleSchema(models, "postgres");
      const statement = new EntityStatements(models[0]!, schema).nearest([], "near", [1, 0, 0], "l2", 2);
      const plan = await adapter.client.begin(async (tx) => {
        await tx.unsafe("set local enable_seqscan = off");
        // quickservicets-allow-unsafe: EXPLAIN of the generated statement, with its parameters
        return tx.unsafe(`explain ${statement.text}`, statement.params as never[]);
      });
      expect(JSON.stringify(plan)).toMatch(/near.*idx|hnsw/i);
    });
  }
});

describe("bounded scans", () => {
  test("on SQLite more candidates than vectors.maxScan fail; QS_VECTORS_MAX_SCAN raises the bound", async () => {
    const adapter = sqliteAdapter({ path: ":memory:" });
    await adapter.connect(models);
    await createSqliteTables((adapter as unknown as { client: never }).client, models);
    const repos = await seeded(adapter);
    configureVectors({ maxScan: 3 });
    try {
      await expect(repos.chunks.query().nearest("embedding", [1, 0, 0]).take(2).toArray()).rejects.toThrow("nearest() scanned more than 3 rows; add filters or use PostgreSQL with pgvector");
      const resolved = resolveConfig({ database: memoryAdapter(), vectors: { maxScan: 3 } } as ServiceConfig, { QS_VECTORS_MAX_SCAN: "10" });
      expect(resolved.vectors).toEqual({ maxScan: 10 });
      configureVectors(resolved.vectors);
      expect(((await repos.chunks.query().nearest("embedding", [1, 0, 0]).take(2).toArray()) as Chunk[]).map((chunk) => chunk.text)).toEqual(["a", "b"]);
    } finally {
      configureVectors({ maxScan: DEFAULT_MAX_SCAN });
      await adapter.disconnect();
    }
  });
});
