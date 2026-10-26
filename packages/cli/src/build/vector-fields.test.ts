import { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildDrizzleSchema,
  createApp,
  createRepositories,
  memoryAdapter,
  mongodbAdapter,
  postgresAdapter,
  resolveConfig,
  sqliteAdapter,
  type DatabaseAdapter,
  type EntityModel,
  type Repository,
} from "@quickservicets/core";
import { postgresDdl } from "../../../core/src/testing/postgres.ts";
import { createSqliteTables } from "../../../core/src/testing/sql.ts";
import { parseEntities } from "../entities/parse-entities.ts";
import { addMigration } from "../migrations/add.ts";
import { generateOpenApi } from "../openapi/generate-openapi.ts";
import { createLinkedProject, createProject, MEMORY_CONFIG } from "../testing/project.ts";
import { build, crudTable, HNSW_ONLY_ON_POSTGRES, vectorIndexWarnings } from "./build.ts";

const chunk = (tag = "@vector 3", type = "number[]") => `export type Chunk = {\n  text: string;\n  /** ${tag} */ embedding?: ${type};\n};\n`;
const modelsOf = (source: string): EntityModel[] => parseEntities(createProject({ "entities/Chunk.ts": source }));
const failure = (source: string): string => {
  try {
    modelsOf(source);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the parser to fail");
};
const quiet = { info() {}, warn() {}, error() {} };

describe("@vector tag", () => {
  test("records the dimensions with the default metric and index", () => {
    const [model] = modelsOf(chunk());
    expect(model!.fields.find((field) => field.name === "embedding")).toMatchObject({
      type: "array",
      items: { type: "number" },
      optional: true,
      vector: { dimensions: 3, metric: "cosine", index: "none" },
    });
  });

  test("takes metric and index options, on required fields too", () => {
    const [model] = modelsOf("export type Chunk = { /** @vector 1536 metric=l2 index=hnsw */ embedding: number[] };");
    expect(model!.fields[0]).toMatchObject({ optional: false, vector: { dimensions: 1536, metric: "l2", index: "hnsw" } });
    expect(modelsOf(chunk("@vector 8 metric=ip"))[0]!.fields[1]!.vector).toEqual({ dimensions: 8, metric: "ip", index: "none" });
  });

  test("needs a top-level number[] field", () => {
    expect(failure(chunk("@vector 3", "string"))).toBe("entities/Chunk.ts: @vector needs a number[] field");
    expect(failure(chunk("@vector 3", "string[]"))).toBe("entities/Chunk.ts: @vector needs a number[] field");
    expect(failure("export type Chunk = { meta: { /** @vector 3 */ values: number[] } };")).toBe("entities/Chunk.ts: @vector needs a number[] field");
  });

  test("checks the dimensions and options", () => {
    for (const tag of ["@vector", "@vector 0", "@vector 16001", "@vector x", "@vector 3 metric=dot", "@vector 3 index=ivfflat", "@vector 3 size=2"]) {
      expect(failure(chunk(tag))).toContain('entities/Chunk.ts: field "embedding" has invalid @vector');
    }
    expect(modelsOf(chunk("@vector 16000"))[0]!.fields[1]!.vector!.dimensions).toBe(16000);
  });

  test("an HNSW index supports at most 2000 dimensions", () => {
    expect(failure(chunk("@vector 3000 index=hnsw"))).toBe("entities/Chunk.ts: @vector index=hnsw supports at most 2000 dimensions");
    expect(modelsOf(chunk("@vector 2000 index=hnsw"))[0]!.fields[1]!.vector!.index).toBe("hnsw");
  });
});

async function serverFor(database: DatabaseAdapter = memoryAdapter()) {
  const models = modelsOf(chunk());
  const config = resolveConfig({ database, logger: quiet }, {});
  await database.connect(models);
  if (database.kind === "sqlite") await createSqliteTables((database as unknown as { client: never }).client, models);
  const { server, repos } = createApp({ models, crudRoutes: [], endpoints: [], hooks: new Map(), config });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await server.fetch(new Request(`http://x${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { call, repos: repos as unknown as { chunks: Repository<any, any> }, database };
}

describe("writes", () => {
  const invalid = () => ({ error: { code: "VALIDATION_ERROR", message: "Invalid body", details: [{ field: "embedding", message: "Must be a list of 3 numbers" }] } });

  test("bodies take exactly <dimensions> finite numbers, or null", async () => {
    const { call } = await serverFor();
    const created = await call("POST", "/chunks", { text: "a", embedding: [0.1, 0.2, 0.3] });
    expect(created.status).toBe(201);
    for (const embedding of [[1, 2], [1, 2, 3, 4], ["a", 1, 2], [1, null, 2], "1,2,3", {}]) {
      const response = await call("POST", "/chunks", { text: "b", embedding });
      expect(response.status).toBe(400);
      expect(response.body).toEqual(invalid());
    }
    expect((await call("PATCH", `/chunks/${created.body.id}`, { embedding: [1, 2] })).status).toBe(400);
    expect((await call("PATCH", `/chunks/${created.body.id}`, { embedding: null })).status).toBe(200);
  });

  test("repository writes are checked the same way", async () => {
    const { repos } = await serverFor();
    await expect(repos.chunks.create({ text: "a", embedding: [1, 2] })).rejects.toMatchObject({
      status: 400,
      details: [{ field: "embedding", message: "Must be a list of 3 numbers" }],
    });
    const created = await repos.chunks.create({ text: "a", embedding: [1, 2, 3] });
    await expect(repos.chunks.update(created.id, { embedding: [Number.NaN, 1, 2] })).rejects.toMatchObject({ status: 400 });
  });
});

describe("storage", () => {
  test("PostgreSQL uses a vector column and an HNSW index by metric", async () => {
    for (const [metric, operatorClass] of [["cosine", "vector_cosine_ops"], ["l2", "vector_l2_ops"], ["ip", "vector_ip_ops"]] as const) {
      const ddl = (await postgresDdl(modelsOf(chunk(`@vector 3 index=hnsw metric=${metric}`)))).join("\n");
      expect(ddl).toContain('"embedding" vector(3)');
      expect(ddl).toContain(`CREATE INDEX "chunks_embedding_hnsw" ON "chunks" USING hnsw ("embedding" ${operatorClass});`);
    }
    const plain = (await postgresDdl(modelsOf(chunk()))).join("\n");
    expect(plain).not.toContain("hnsw");
    expect(buildDrizzleSchema(modelsOf(chunk("@vector 3 index=hnsw")), "sqlite").tables.Chunk).toBeDefined();
  });

  test("migration add creates the extension in the first migration with a vector column", async () => {
    const root = createLinkedProject({
      "quickservicets.config.ts":
        'import { defineConfig, postgresAdapter } from "@quickservicets/core";\nexport default defineConfig({ database: postgresAdapter({ url: "postgres://localhost/none" }) });\n',
      "entities/Chunk.ts": "export type Chunk = { text: string };\n",
    });
    const at = (seconds: number) => new Date(Date.UTC(2026, 9, 25, 12, 0, seconds));
    const initial = readFileSync(join(root, (await addMigration(root, "Initial", at(0))).file), "utf8");
    expect(initial).not.toContain("EXTENSION");
    Bun.write(join(root, "entities/Chunk.ts"), chunk("@vector 3 index=hnsw metric=l2"));
    const [up] = readFileSync(join(root, (await addMigration(root, "Embeddings", at(1))).file), "utf8").split("export async function down");
    const statements = [...up!.matchAll(/ctx\.sql\("((?:[^"\\]|\\.)*)"/g)].map((match) => JSON.parse(`"${match[1]}"`) as string);
    expect(statements[0]).toBe("CREATE EXTENSION IF NOT EXISTS vector;");
    expect(statements.join("\n")).toContain('ADD COLUMN "embedding" vector(3)');
    expect(statements.join("\n")).toContain('USING hnsw ("embedding" vector_l2_ops)');
    Bun.write(join(root, "entities/Chunk.ts"), chunk("@vector 3 index=hnsw metric=l2").replace("text: string;", "text: string;\n  title?: string;"));
    const next = readFileSync(join(root, (await addMigration(root, "Title", at(2))).file), "utf8");
    expect(next).not.toContain("EXTENSION");
  });

  const factories: [string, () => DatabaseAdapter][] = [
    ["memory", () => memoryAdapter()],
    ["sqlite", () => sqliteAdapter({ path: ":memory:" })],
  ];
  if (process.env.TEST_MONGODB_URL) {
    factories.push(["mongodb", () => mongodbAdapter({ url: process.env.TEST_MONGODB_URL!, database: `qs_vector_${Bun.randomUUIDv7().replaceAll("-", "")}` })]);
  } else {
    test.skip("vector storage on MongoDB (set TEST_MONGODB_URL to run)", () => {});
  }
  test.each(factories)("%s reads a stored vector back as the same number array", async (_, factory) => {
    const { repos, database } = await serverFor(factory());
    try {
      const created = await repos.chunks.create({ text: "a", embedding: [0.25, -1.5, 3] });
      expect((await repos.chunks.findById(created.id))!.embedding).toEqual([0.25, -1.5, 3]);
      expect((await repos.chunks.list({ where: [], sort: [{ field: "id", direction: "asc" }], limit: 10, offset: 0 })).data[0]!.embedding).toEqual([0.25, -1.5, 3]);
    } finally {
      if (database.kind === "mongodb") await (database as unknown as { db: { dropDatabase(): Promise<unknown> } }).db.dropDatabase();
      await database.disconnect();
    }
  });

  test("the HNSW index warns once on databases other than PostgreSQL", () => {
    const models = parseEntities(createProject({ "entities/Chunk.ts": chunk("@vector 3 index=hnsw"), "entities/Page.ts": chunk("@vector 4 index=hnsw").replace("Chunk", "Page") }));
    for (const kind of ["sqlite", "mongodb", "memory", undefined]) expect(vectorIndexWarnings(models, kind)).toEqual([HNSW_ONLY_ON_POSTGRES]);
    expect(vectorIndexWarnings(models, "postgres")).toEqual([]);
    expect(vectorIndexWarnings(modelsOf(chunk()), "sqlite")).toEqual([]);
  });

  test("the build prints the warning", async () => {
    const root = createLinkedProject({ "quickservicets.config.ts": MEMORY_CONFIG, "entities/Chunk.ts": chunk("@vector 3 index=hnsw") });
    expect((await build(root)).warnings).toContain("@vector index=hnsw is used only on PostgreSQL");
  });
});

const postgresUrl = process.env.TEST_POSTGRES_URL;
const pgvector = postgresUrl
  ? await (async () => {
      const client = new SQL(postgresUrl);
      try {
        return (await client`select 1 from pg_available_extensions where name = 'vector'`).length > 0;
      } finally {
        await client.close();
      }
    })()
  : false;
if (pgvector) {
  test("PostgreSQL stores and reads vectors through pgvector", async () => {
    const models = modelsOf(chunk("@vector 3 index=hnsw"));
    const database = postgresAdapter({ url: postgresUrl! });
    await database.connect(models);
    const client = database.client!;
    await client.unsafe("drop schema if exists public cascade; create schema public; create extension if not exists vector;");
    for (const statement of await postgresDdl(models)) {
      // quickservicets-allow-unsafe: runs the DDL drizzle-kit generates from the models
      await client.unsafe(statement);
    }
    try {
      const repos = createRepositories(models, database) as unknown as { chunks: Repository<any, any> };
      const created = await repos.chunks.create({ text: "a", embedding: [0.25, -1.5, 3] });
      expect(created.embedding).toEqual([0.25, -1.5, 3]);
      expect((await repos.chunks.findById(created.id))!.embedding).toEqual([0.25, -1.5, 3]);
      expect((await repos.chunks.findById(created.id, { omit: ["embedding"] }))!).not.toHaveProperty("embedding");
      const page = await repos.chunks.list({ where: [], sort: [{ field: "id", direction: "asc" }], limit: 10, offset: 0 }, { omit: ["embedding"] });
      expect(page.data).toEqual([expect.objectContaining({ id: created.id, text: "a" })]);
      expect(page.data[0]).not.toHaveProperty("embedding");
    } finally {
      await client.unsafe("drop schema if exists public cascade; create schema public;");
      await database.disconnect();
    }
  });
} else {
  test.skip("PostgreSQL vector storage (set TEST_POSTGRES_URL to a server with pgvector to run)", () => {});
}

describe("responses", () => {
  test("list and read leave vectors out unless fields selects them", async () => {
    for (const database of [memoryAdapter(), sqliteAdapter({ path: ":memory:" })]) {
      const { call } = await serverFor(database);
      const created = await call("POST", "/chunks", { text: "a", embedding: [0.1, 0.2, 0.3] });
      expect(created.body.embedding).toEqual([0.1, 0.2, 0.3]);
      const id = created.body.id as string;
      expect((await call("GET", "/chunks")).body.data).toEqual([expect.not.objectContaining({ embedding: expect.anything() })]);
      expect((await call("GET", "/chunks")).body.data).toEqual([expect.objectContaining({ id, text: "a" })]);
      expect((await call("GET", `/chunks/${id}`)).body).not.toHaveProperty("embedding");
      expect((await call("GET", `/chunks/${id}?fields=id,embedding`)).body).toEqual({ id, embedding: [0.1, 0.2, 0.3] });
      expect((await call("GET", "/chunks?fields=embedding")).body.data).toEqual([{ embedding: [0.1, 0.2, 0.3] }]);
      expect((await call("GET", `/chunks/${id}?exclude=text`)).body).not.toHaveProperty("embedding");
      expect((await call("GET", `/chunks/${id}?fields=text,embedding&exclude=embedding`)).body).toEqual({ text: "a" });
      await database.disconnect();
    }
  });

  test("the routes do not read vector columns they leave out", async () => {
    const database = memoryAdapter();
    const omitted: unknown[] = [];
    const findById = database.findById.bind(database);
    const findMany = database.findMany.bind(database);
    database.findById = (entity, id, options) => (omitted.push(options?.omit), findById(entity, id, options));
    database.findMany = (entity, options) => (omitted.push(options.omit), findMany(entity, options));
    const { call } = await serverFor(database);
    const id = (await call("POST", "/chunks", { text: "a", embedding: [1, 2, 3] })).body.id as string;
    omitted.length = 0;
    await call("GET", "/chunks");
    await call("GET", `/chunks/${id}`);
    await call("GET", `/chunks/${id}?fields=embedding`);
    expect(omitted).toEqual([["embedding"], ["embedding"], undefined]);
  });

  test("vectors cannot be filtered or sorted", async () => {
    const { call, repos } = await serverFor();
    for (const query of ["where[embedding]=1", "where[embedding][eq]=1", "sort=embedding"]) {
      const response = await call("GET", `/chunks?${query}`);
      expect(response.status).toBe(400);
      expect((response.body.error as { code: string }).code).toBe("VALIDATION_ERROR");
    }
    expect(() => repos.chunks.query().orderBy((chunk: any) => chunk.embedding)).toThrow('Chunk cannot be ordered by "embedding"');
  });

  test("repository reads return vectors unless a select leaves them out", async () => {
    const { repos } = await serverFor();
    const created = await repos.chunks.create({ text: "a", embedding: [1, 2, 3] });
    expect((await repos.chunks.findById(created.id))!.embedding).toEqual([1, 2, 3]);
    expect((await repos.chunks.query().toArray())[0]!.embedding).toEqual([1, 2, 3]);
    expect(await repos.chunks.query().select("id", "text").toArray()).toEqual([{ id: created.id, text: "a" }]);
  });
});

describe("OpenAPI", () => {
  const documentOf = (models: EntityModel[]) =>
    generateOpenApi({ models, routes: crudTable(models), hooks: new Map(), packageJson: {}, endpoints: [], populateMaxDepth: 2 }) as unknown as {
      components: { schemas: Record<string, { properties: Record<string, Record<string, unknown>> }> };
    };

  test("a vector is an array of exactly <dimensions> numbers, returned only when selected", () => {
    const schemas = documentOf(modelsOf(chunk())).components.schemas;
    expect(schemas.Chunk!.properties.embedding).toEqual({
      type: ["array", "null"],
      items: { type: "number" },
      minItems: 3,
      maxItems: 3,
      description: "Returned only when selected with fields.",
    });
    const input = Object.entries(schemas).find(([name]) => name !== "Chunk" && name.startsWith("Chunk") && schemas[name]!.properties.embedding)!;
    expect(input[1].properties.embedding).toMatchObject({ minItems: 3, maxItems: 3 });
  });

  test("entities without vectors document the same schema as before", () => {
    const models = modelsOf("export type Chunk = { text: string; scores?: number[] };");
    expect(documentOf(models).components.schemas.Chunk!.properties.scores).toEqual({ type: ["array", "null"], items: { type: "number" } });
  });
});
