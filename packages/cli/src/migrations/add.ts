import {
  buildDrizzleSchema,
  databaseAdapters,
  databaseModels,
  DEFAULT_DATABASE,
  loadConfig,
  SQLITE_DEFAULT_SCHEMA_TOKEN,
  storageConfigured,
  type EntityModel,
  type ResolvedConfig,
  type SqlDialect,
} from "@quickservicets/core";
import { getTableConfig as pgTableConfig } from "drizzle-orm/pg-core";
import { getTableConfig as sqliteTableConfig } from "drizzle-orm/sqlite-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseProjectEntities as parseEntities } from "../entities/parse-entities.ts";
import { BuildError } from "../errors.ts";
import { diffSnapshots, losesData } from "./diff.ts";
import { planMongoMigration, type MongoMigrationPlan } from "./mongo.ts";
import { suggestMigrationName } from "./naming.ts";
import { sharedStatementResolver, statementSchemaResolver } from "./statement-schema.ts";
import {
  drizzleSnapshot,
  listMigrations,
  migrationsFolder,
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
  /** With tenancy: whether each `up` statement changes a table of a shared default-schema model. */
  upShared?: boolean[];
  /** With tenancy: whether each `down` statement changes a table of a shared default-schema model. */
  downShared?: boolean[];
  previousModels: EntityModel[];
}

export interface CreatedMigration {
  id: string;
  file: string;
  snapshot: string;
  /** The database the migration is for: `default`, or a name of `databases`. */
  database?: string;
}

/** What `migration add` wrote: the first migration, every migration with its database, and the skipped memory databases. */
export interface AddedMigrations extends CreatedMigration {
  database: string;
  migrations: (CreatedMigration & { database: string })[];
  /** Named databases on the memory adapter, which keep no schema. */
  skipped: string[];
  /** Every database of the project, `default` first. */
  databases: string[];
}

export function sqlDialectOf(kind: string | undefined): SqlDialect | undefined {
  return kind === "sqlite" || kind === "postgres" ? kind : undefined;
}

/** Diffs the current models against the latest migration snapshot. */
export async function planMigration(projectRoot: string, models: EntityModel[], dialect: SqlDialect, database?: string): Promise<MigrationPlan> {
  const previous = readLatestSnapshot(projectRoot, database);
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
  // With tenancy, statements of shared default-schema tables run in the service's database only.
  const tenancy = models.some((model) => model.tenancy !== undefined);
  const sharedOf = tenancy ? sharedStatementResolver(dialect, [previousModels, models], [before, after]) : undefined;
  return {
    ...(sharedOf ? { upShared: up.map(sharedOf), downShared: down.map(sharedOf) } : {}),
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

export async function hasPendingChanges(projectRoot: string, models: EntityModel[], dialect: SqlDialect, database?: string): Promise<boolean> {
  return (await planMigration(projectRoot, models, dialect, database)).up.length > 0;
}

function timestamp(date: Date): string {
  return date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

function nextId(projectRoot: string, name: string, now: Date, databases: readonly string[] = [DEFAULT_DATABASE]): string {
  // One timestamp for every database, after the latest migration of any of them.
  const latest = databases.flatMap((database) => listMigrations(projectRoot, database).map((migration) => migration.id.slice(0, 14))).sort().at(-1);
  let stamp = timestamp(now);
  if (latest && stamp <= latest) {
    // Keep ids strictly increasing even when two migrations are created within the same second.
    const parsed = new Date(`${latest.slice(0, 4)}-${latest.slice(4, 6)}-${latest.slice(6, 8)}T${latest.slice(8, 10)}:${latest.slice(10, 12)}:${latest.slice(12, 14)}Z`);
    stamp = timestamp(new Date(parsed.getTime() + 1000));
  }
  return `${stamp}_${name}`;
}

function sqlBody(statements: string[], schemas: (string | undefined)[] = [], shared: boolean[] = []): string {
  return statements
    .map((statement, index) => {
      const schema = schemas[index];
      const options = schema ? `, { schema: ${JSON.stringify(schema)} }` : shared[index] ? ", { shared: true }" : "";
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
    upShared?: boolean[];
    downShared?: boolean[];
  },
): string {
  const mongo = plan.dialect === "mongodb";
  const contextType = mongo ? "MongoMigrationContext" : "MigrationContext";
  const body = (statements: string[], schemas?: (string | undefined)[], shared?: boolean[]) => (mongo ? codeBody(statements) : sqlBody(statements, schemas, shared));
  return `// Generated by quickservicets migration add. Review and edit as needed.
// ctx.repos reflects the latest model, not the model at the time of this migration.
import type { ${contextType} } from "@quickservicets/core";

export async function up(ctx: ${contextType}): Promise<void> {
${body(plan.up, plan.upSchemas, plan.upShared)}
}

export async function down(ctx: ${contextType}): Promise<void> {
${body(plan.down, plan.downSchemas, plan.downShared)}
}
`;
}

/** Writes a migration and its snapshot for an already computed plan, in the folder of `database`. */
export function writeMigration(projectRoot: string, name: string, plan: AnyPlan, now = new Date(), database?: string, id?: string): CreatedMigration {
  if (!MIGRATION_NAME.test(name)) {
    throw new BuildError(`Migration names must be PascalCase and match ^[A-Z][A-Za-z0-9]*$ (got "${name}")`);
  }
  const existing = listMigrations(projectRoot, database).find((migration) => migration.name === name);
  if (existing) throw new BuildError(`A migration named ${name} already exists: ${existing.id}`);
  const migrationId = id ?? nextId(projectRoot, name, now);
  const folder = migrationsFolder(projectRoot, database);
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `${migrationId}.ts`);
  writeFileSync(file, migrationSource(plan));
  const snapshot = writeSnapshot(
    projectRoot,
    migrationId,
    plan.dialect === "mongodb"
      ? { dialect: "mongodb", models: plan.models, indexes: plan.indexes }
      : { dialect: plan.dialect, models: plan.models, drizzle: plan.drizzle },
    database,
  );
  return { id: migrationId, file: relative(projectRoot, file), snapshot: relative(projectRoot, snapshot) };
}

/** One database a migration command works on: its name, kind, dialect (none for memory) and models. */
export interface MigrationTarget {
  database: string;
  kind: string | undefined;
  dialect?: SqlDialect | "mongodb";
  models: EntityModel[];
}

/** The dialect of an adapter kind, or undefined for memory; fails for an adapter migrations do not support. */
function dialectOfKind(kind: string | undefined): SqlDialect | "mongodb" | undefined {
  if (kind === "memory") return undefined;
  const dialect = kind === "mongodb" ? "mongodb" : sqlDialectOf(kind);
  if (!dialect) throw new BuildError(`Migrations are not supported for the ${kind ?? "configured"} adapter`);
  return dialect;
}

/** Every database of a resolved config with the models whose tables live in it: default first, then by name. */
export function migrationTargets(config: ResolvedConfig, models: EntityModel[]): MigrationTarget[] {
  return databaseAdapters(config.database).map(([database, adapter]) => {
    const dialect = dialectOfKind(adapter.kind);
    return { database, kind: adapter.kind, ...(dialect ? { dialect } : {}), models: databaseModels(models, database) };
  });
}

/** The project's databases with their models, failing when every one is memory. */
async function migrationProject(projectRoot: string): Promise<MigrationTarget[]> {
  const config = await loadConfig(projectRoot);
  const models = parseEntities(projectRoot, config.features, { storage: storageConfigured(config), databases: Object.keys(config.databases) });
  const targets = migrationTargets(config, models);
  if (targets.every((target) => !target.dialect)) throw new BuildError("Migrations are not used with the memory adapter");
  return targets;
}

async function planOf(projectRoot: string, target: MigrationTarget): Promise<AnyPlan> {
  // The default database keeps the folder's historical calls, without a database name.
  const database = target.database === DEFAULT_DATABASE ? undefined : target.database;
  return target.dialect === "mongodb" ? planMongoMigration(projectRoot, target.models, database) : planMigration(projectRoot, target.models, target.dialect!, database);
}

/**
 * Writes one migration, with one timestamp and name, for every database whose model changed (only the default
 * database's empty migration when none changed), skipping memory databases.
 */
async function addFor(projectRoot: string, name: (plans: { target: MigrationTarget; plan: AnyPlan }[]) => string | undefined, now: Date): Promise<AddedMigrations | undefined> {
  const targets = await migrationProject(projectRoot);
  const skipped = targets.filter((target) => !target.dialect).map((target) => target.database);
  const plans: { target: MigrationTarget; plan: AnyPlan }[] = [];
  for (const target of targets) if (target.dialect) plans.push({ target, plan: await planOf(projectRoot, target) });
  const changed = plans.filter(({ plan }) => plan.up.length > 0);
  const chosen = name(changed);
  if (chosen === undefined) return undefined;
  const writing = changed.length > 0 ? changed : plans.filter(({ target }) => target.database === DEFAULT_DATABASE).slice(0, 1);
  if (writing.length === 0) writing.push(plans[0]!);
  const id = nextId(projectRoot, chosen, now, targets.map((target) => target.database));
  const migrations = writing.map(({ target, plan }) => ({
    ...writeMigration(projectRoot, chosen, plan, now, target.database === DEFAULT_DATABASE ? undefined : target.database, id),
    database: target.database,
  }));
  return { ...migrations[0]!, migrations, skipped, databases: targets.map((target) => target.database) };
}

/** `quickservicets migration add <Name>` */
export async function addMigration(projectRoot: string, name: string, now = new Date()): Promise<AddedMigrations> {
  return (await addFor(projectRoot, () => name, now))!;
}

/** Creates a migration named after the change, or returns undefined when nothing changed. Used by `dev`. */
export async function addAutomaticMigration(projectRoot: string, now = new Date()): Promise<AddedMigrations | undefined> {
  return addFor(
    projectRoot,
    (changed) => (changed.length === 0 ? undefined : suggestMigrationName(changed.flatMap(({ plan }) => plan.previousModels), changed.flatMap(({ plan }) => plan.models))),
    now,
  );
}
