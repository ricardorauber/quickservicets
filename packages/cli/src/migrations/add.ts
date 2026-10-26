import { buildDrizzleSchema, loadConfig, SQLITE_DEFAULT_SCHEMA_TOKEN, type EntityModel, type SqlDialect } from "@quickservicets/core";
import { getTableConfig as pgTableConfig } from "drizzle-orm/pg-core";
import { getTableConfig as sqliteTableConfig } from "drizzle-orm/sqlite-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseProjectEntities as parseEntities } from "../entities/parse-entities.ts";
import { BuildError } from "../errors.ts";
import { diffSnapshots, losesData } from "./diff.ts";
import { planMongoMigration, type MongoMigrationPlan } from "./mongo.ts";
import { suggestMigrationName } from "./naming.ts";
import { statementSchemaResolver } from "./statement-schema.ts";
import {
  drizzleSnapshot,
  listMigrations,
  MIGRATIONS_DIR,
  readLatestSnapshot,
  writeSnapshot,
  type DrizzleSnapshot,
} from "./snapshot.ts";

const MIGRATION_NAME = /^[A-Z][A-Za-z0-9]*$/;

export interface MigrationPlan {
  dialect: SqlDialect;
  models: EntityModel[];
  drizzle: DrizzleSnapshot;
  up: string[];
  down: string[];
  /** The explicit schema each `up` statement changes, or undefined for default-schema tables. */
  upSchemas: (string | undefined)[];
  /** The explicit schema each `down` statement changes. */
  downSchemas: (string | undefined)[];
  previousModels: EntityModel[];
}

export interface CreatedMigration {
  id: string;
  file: string;
  snapshot: string;
}

export function sqlDialectOf(kind: string | undefined): SqlDialect | undefined {
  return kind === "sqlite" || kind === "postgres" ? kind : undefined;
}

/** Diffs the current models against the latest migration snapshot. */
export async function planMigration(projectRoot: string, models: EntityModel[], dialect: SqlDialect): Promise<MigrationPlan> {
  const previous = readLatestSnapshot(projectRoot);
  const previousModels = previous?.models ?? [];
  const before = previous && previous.dialect !== "mongodb" ? previous.drizzle : await drizzleSnapshot([], dialect);
  const after = await drizzleSnapshot(models, dialect);
  const renames = joinTableRenames(previousModels, models, dialect);
  const up = [
    ...renames.map((rename) => renameStatement(dialect, rename.from, rename.to)),
    ...(await diffSnapshots(dialect, renameTables(before, renames, dialect, after), after)),
  ];
  const down = [
    ...renames.map((rename) => renameStatement(dialect, rename.to, rename.from)),
    ...(await diffSnapshots(dialect, renameTables(after, renames.map(({ from, to }) => ({ from: to, to: from })), dialect, before), before)),
  ];
  const schemaOf = statementSchemaResolver(dialect, [previousModels, models], [before, after]);
  return {
    dialect,
    models,
    drizzle: after,
    up,
    upSchemas: up.map(schemaOf),
    down,
    downSchemas: down.map(schemaOf),
    previousModels,
  };
}

interface TableRename {
  from: { schema: string | undefined; name: string };
  to: { schema: string | undefined; name: string };
}

/** Physical join tables by identity (`<entity>.<field>` for reference arrays, the link key for N-N relations). */
function joinTables(models: EntityModel[], dialect: SqlDialect): Map<string, { schema: string | undefined; name: string }> {
  const { tables, junctions } = buildDrizzleSchema(models, dialect, { sqliteDefaultPrefix: SQLITE_DEFAULT_SCHEMA_TOKEN });
  const config = (table: unknown) => (dialect === "sqlite" ? sqliteTableConfig(table as never) : pgTableConfig(table as never));
  const result = new Map<string, { schema: string | undefined; name: string }>();
  for (const [key, table] of Object.entries(junctions)) {
    const { name, schema } = config(table) as { name: string; schema?: string };
    result.set(key, { name, schema });
  }
  for (const model of models) {
    if (!model.link) continue;
    const { name, schema } = config(tables[model.key]) as { name: string; schema?: string };
    result.set(model.key, { name, schema });
  }
  return result;
}

/** Join tables whose identity is unchanged but whose name changed (e.g. a new `@joinTable`). */
function joinTableRenames(previous: EntityModel[], current: EntityModel[], dialect: SqlDialect): TableRename[] {
  const before = joinTables(previous, dialect);
  const after = joinTables(current, dialect);
  const renames: TableRename[] = [];
  for (const [key, from] of before) {
    const to = after.get(key);
    if (to && (to.name !== from.name || to.schema !== from.schema)) renames.push({ from, to });
  }
  return renames;
}

function renameStatement(dialect: SqlDialect, from: TableRename["from"], to: TableRename["to"]): string {
  if (dialect === "sqlite") return `ALTER TABLE \`${from.name}\` RENAME TO \`${to.name}\`;`;
  const qualified = from.schema ? `"${from.schema}"."${from.name}"` : `"${from.name}"`;
  return `ALTER TABLE ${qualified} RENAME TO "${to.name}";`;
}

/**
 * A copy of a snapshot with tables renamed, so the diff sees them as kept instead of dropped and created. SQLite
 * foreign keys are unnamed in the database, so their names are taken from `target` to avoid rebuilding the table.
 */
function renameTables(snapshot: DrizzleSnapshot, renames: TableRename[], dialect: SqlDialect, target: DrizzleSnapshot): DrizzleSnapshot {
  if (renames.length === 0) return snapshot;
  const keyOf = (table: TableRename["from"]) => (dialect === "sqlite" ? table.name : `${table.schema ?? "public"}.${table.name}`);
  const tables = { ...snapshot.tables };
  for (const { from, to } of renames) {
    const table = tables[keyOf(from)];
    if (!table) continue;
    delete tables[keyOf(from)];
    const targetTable = target.tables[keyOf(to)];
    tables[keyOf(to)] = {
      ...table,
      name: to.name,
      ...(dialect === "sqlite" && targetTable ? { foreignKeys: targetTable.foreignKeys } : {}),
    };
  }
  return { ...snapshot, tables };
}

export async function hasPendingChanges(projectRoot: string, models: EntityModel[], dialect: SqlDialect): Promise<boolean> {
  return (await planMigration(projectRoot, models, dialect)).up.length > 0;
}

function timestamp(date: Date): string {
  return date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

function nextId(projectRoot: string, name: string, now: Date): string {
  const latest = listMigrations(projectRoot).at(-1)?.id.slice(0, 14);
  let stamp = timestamp(now);
  if (latest && stamp <= latest) {
    // Keep ids strictly increasing even when two migrations are created within the same second.
    const parsed = new Date(`${latest.slice(0, 4)}-${latest.slice(4, 6)}-${latest.slice(6, 8)}T${latest.slice(8, 10)}:${latest.slice(10, 12)}:${latest.slice(12, 14)}Z`);
    stamp = timestamp(new Date(parsed.getTime() + 1000));
  }
  return `${stamp}_${name}`;
}

function sqlBody(statements: string[], schemas: (string | undefined)[] = []): string {
  return statements
    .map((statement, index) => {
      const schema = schemas[index];
      const options = schema ? `, { schema: ${JSON.stringify(schema)} }` : "";
      const call = `  await ctx.sql(${JSON.stringify(statement.trim())}${options});`;
      return losesData(statement) ? `  // WARNING: possible data loss\n${call}` : call;
    })
    .join("\n");
}

const codeBody = (lines: string[]) => lines.map((line) => `  ${line}`).join("\n");

type AnyPlan = MigrationPlan | MongoMigrationPlan;

export function migrationSource(
  plan: Pick<AnyPlan, "up" | "down"> & {
    dialect?: AnyPlan["dialect"];
    upSchemas?: (string | undefined)[];
    downSchemas?: (string | undefined)[];
  },
): string {
  const mongo = plan.dialect === "mongodb";
  const contextType = mongo ? "MongoMigrationContext" : "MigrationContext";
  const body = (statements: string[], schemas?: (string | undefined)[]) => (mongo ? codeBody(statements) : sqlBody(statements, schemas));
  return `// Generated by quickservicets migration add. Review and edit as needed.
// ctx.repos reflects the latest model, not the model at the time of this migration.
import type { ${contextType} } from "@quickservicets/core";

export async function up(ctx: ${contextType}): Promise<void> {
${body(plan.up, plan.upSchemas)}
}

export async function down(ctx: ${contextType}): Promise<void> {
${body(plan.down, plan.downSchemas)}
}
`;
}

/** Writes a migration and its snapshot for an already computed plan. */
export function writeMigration(projectRoot: string, name: string, plan: AnyPlan, now = new Date()): CreatedMigration {
  if (!MIGRATION_NAME.test(name)) {
    throw new BuildError(`Migration names must be PascalCase and match ^[A-Z][A-Za-z0-9]*$ (got "${name}")`);
  }
  const existing = listMigrations(projectRoot).find((migration) => migration.name === name);
  if (existing) throw new BuildError(`A migration named ${name} already exists: ${existing.id}`);
  const id = nextId(projectRoot, name, now);
  mkdirSync(join(projectRoot, MIGRATIONS_DIR), { recursive: true });
  const file = join(projectRoot, MIGRATIONS_DIR, `${id}.ts`);
  writeFileSync(file, migrationSource(plan));
  const snapshot = writeSnapshot(
    projectRoot,
    id,
    plan.dialect === "mongodb"
      ? { dialect: "mongodb", models: plan.models, indexes: plan.indexes }
      : { dialect: plan.dialect, models: plan.models, drizzle: plan.drizzle },
  );
  return { id, file: relative(projectRoot, file), snapshot: relative(projectRoot, snapshot) };
}

async function migrationProject(projectRoot: string): Promise<{ dialect: SqlDialect | "mongodb"; models: EntityModel[] }> {
  const config = await loadConfig(projectRoot);
  if (config.database.kind === "memory") throw new BuildError("Migrations are not used with the memory adapter");
  const dialect = config.database.kind === "mongodb" ? "mongodb" : sqlDialectOf(config.database.kind);
  if (!dialect) throw new BuildError(`Migrations are not supported for the ${config.database.kind ?? "configured"} adapter`);
  return { dialect, models: parseEntities(projectRoot, config.features) };
}

async function planFor(projectRoot: string): Promise<AnyPlan> {
  const { dialect, models } = await migrationProject(projectRoot);
  return dialect === "mongodb" ? planMongoMigration(projectRoot, models) : planMigration(projectRoot, models, dialect);
}

/** `quickservicets migration add <Name>` */
export async function addMigration(projectRoot: string, name: string, now = new Date()): Promise<CreatedMigration> {
  return writeMigration(projectRoot, name, await planFor(projectRoot), now);
}

/** Creates a migration named after the change, or returns undefined when nothing changed. Used by `dev`. */
export async function addAutomaticMigration(projectRoot: string, now = new Date()): Promise<CreatedMigration | undefined> {
  const plan = await planFor(projectRoot);
  const models = plan.models;
  if (plan.up.length === 0) return undefined;
  return writeMigration(projectRoot, suggestMigrationName(plan.previousModels, models), plan, now);
}
