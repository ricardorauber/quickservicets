import { loadConfig, SQLITE_DEFAULT_SCHEMA_TOKEN, sqliteDefaultPrefix, type MigrationContext, type Repositories, type SqlDialect } from "@quickservicets/core";
import { BuildError } from "../errors.ts";
import { sqlDialectOf } from "./add.ts";
import { HISTORY_TABLE, MONGO_HISTORY_COLLECTION, splitSqlOptions } from "./migrate.ts";
import { listMigrations, type MigrationFile } from "./snapshot.ts";

export interface ScriptOptions {
  from?: string;
  to?: string;
}

function literal(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return `'${value.toISOString()}'`;
  return `'${String(value).replaceAll("'", "''")}'`;
}

function renderQuery(query: TemplateStringsArray | string, values: unknown[]): string {
  if (typeof query === "string") {
    let index = 0;
    return values.length === 0 ? query : query.replace(/\?|\$\d+/g, () => literal(values[index++]));
  }
  return query.reduce((text, part, index) => text + (index > 0 ? literal(values[index - 1]) : "") + part, "");
}

/** A stand-in for `ctx.db`/`ctx.repos` that records a marker the first time it is used. */
function customCodeMarker(onUse: () => void): unknown {
  const handler: ProxyHandler<() => void> = {
    get: (_, key) => {
      if (key === "then") return undefined;
      onUse();
      return proxy;
    },
    apply: () => {
      onUse();
      return proxy;
    },
  };
  const proxy: unknown = new Proxy(() => {}, handler);
  return proxy;
}

async function recordStatements(migration: MigrationFile, direction: "up" | "down"): Promise<string[]> {
  const statements: string[] = [];
  let markedCustom = false;
  const markCustom = () => {
    if (markedCustom) return;
    markedCustom = true;
    statements.push(`-- custom code in ${migration.id}, not scriptable`);
  };
  const ctx: MigrationContext = {
    sql: async (query: TemplateStringsArray | string, ...values: unknown[]) => {
      statements.push(renderQuery(query, splitSqlOptions(query, values).values).trim().replace(/;?$/, ";"));
      return undefined;
    },
    db: customCodeMarker(markCustom),
    repos: customCodeMarker(markCustom) as Repositories,
  };
  const module = (await import(migration.file)) as Record<"up" | "down", (context: MigrationContext) => Promise<void>>;
  await module[direction](ctx);
  return statements;
}

async function recordMongoStatements(migration: MigrationFile, direction: "up" | "down"): Promise<string[]> {
  const statements: string[] = [];
  let markedCustom = false;
  const markCustom = () => {
    if (markedCustom) return;
    markedCustom = true;
    statements.push(`// custom code in ${migration.id}, not scriptable`);
  };
  const databaseFor = (schema?: string) => {
    const target = schema ? `db.getSiblingDB(${JSON.stringify(schema.replaceAll("-", "_"))})` : "db";
    const collection = (name: string) =>
      new Proxy(
        {
          createIndex: async (keys: unknown, options: unknown) => {
            statements.push(`${target}.${name}.createIndex(${JSON.stringify(keys)}, ${JSON.stringify(options)});`);
          },
          dropIndex: async (index: unknown) => {
            statements.push(`${target}.${name}.dropIndex(${JSON.stringify(index)});`);
          },
        } as Record<string | symbol, unknown>,
        { get: (target, key) => (key in target ? target[key] : customCodeMarker(markCustom)) },
      );
    return new Proxy({ collection } as Record<string | symbol, unknown>, {
      get: (target, key) => (key === "collection" ? target.collection : key === "then" ? undefined : customCodeMarker(markCustom)),
    });
  };
  const module = (await import(migration.file)) as Record<"up" | "down", (context: unknown) => Promise<void>>;
  await module[direction]({ db: databaseFor, client: customCodeMarker(markCustom), repos: customCodeMarker(markCustom) });
  return statements;
}

function mongoHistoryStatement(migration: MigrationFile, direction: "up" | "down"): string {
  return direction === "up"
    ? `db.${MONGO_HISTORY_COLLECTION}.insertOne({ _id: ${JSON.stringify(migration.id)}, name: ${JSON.stringify(migration.name)}, appliedAt: new Date() });`
    : `db.${MONGO_HISTORY_COLLECTION}.deleteOne({ _id: ${JSON.stringify(migration.id)} });`;
}

function historyStatement(dialect: SqlDialect, migration: MigrationFile, direction: "up" | "down"): string {
  if (direction === "down") return `delete from ${HISTORY_TABLE} where id = ${literal(migration.id)};`;
  const now = dialect === "postgres" ? "now()" : "cast(strftime('%s', 'now') as integer) * 1000";
  return `insert into ${HISTORY_TABLE} (id, name, applied_at) values (${literal(migration.id)}, ${literal(migration.name)}, ${now});`;
}

function position(point: string, files: MigrationFile[]): number {
  if (point === "0") return -1;
  const index = files.findIndex((file) => file.id === point || file.name === point);
  if (index < 0) throw new BuildError(`Unknown migration: ${point}`);
  return index;
}

/** `quickservicets migration script [from] [to]`: the SQL between two migration points, without executing it. */
export async function migrationScript(projectRoot: string, options: ScriptOptions = {}): Promise<string> {
  const config = await loadConfig(projectRoot);
  const mongo = config.database.kind === "mongodb";
  const dialect = mongo ? "postgres" : sqlDialectOf(config.database.kind);
  if (!dialect) throw new BuildError(`Migration scripts are not supported for the ${config.database.kind ?? "configured"} adapter`);
  const files = listMigrations(projectRoot);
  const from = position(options.from ?? "0", files);
  const to = options.to === undefined ? files.length - 1 : position(options.to, files);

  const steps =
    to >= from
      ? files.slice(from + 1, to + 1).map((migration) => ({ migration, direction: "up" as const }))
      : files
          .slice(to + 1, from + 1)
          .reverse()
          .map((migration) => ({ migration, direction: "down" as const }));

  const blocks: string[] = [];
  for (const { migration, direction } of steps) {
    if (mongo) {
      const statements = await recordMongoStatements(migration, direction);
      blocks.push([`// ${migration.id} (${direction})`, ...statements, mongoHistoryStatement(migration, direction)].join("\n"));
      continue;
    }
    const prefix = dialect === "sqlite" ? sqliteDefaultPrefix(config.schema) : "";
    const statements = (await recordStatements(migration, direction)).map((statement) =>
      statement.replaceAll(SQLITE_DEFAULT_SCHEMA_TOKEN, prefix),
    );
    blocks.push(
      [`-- ${migration.id} (${direction})`, ...statements, historyStatement(dialect, migration, direction).replace(HISTORY_TABLE, `${prefix}${HISTORY_TABLE}`)].join("\n"),
    );
  }
  return blocks.length > 0 ? `${blocks.join("\n\n")}\n` : "";
}
