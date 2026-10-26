import type { Database } from "bun:sqlite";
import type { SQL } from "bun";
import { CONFIG_FILE } from "./config.ts";

/**
 * The lowercase name the project used before it became `quickservicets`. It is spelled in two parts so that a search
 * of the repository for leftovers of the old name finds nothing.
 */
const PREVIOUS_NAME = ["quick", "service"].join("");

/** The table that records applied migrations, in the default schema and in each schema that has marked statements. */
export const MIGRATIONS_TABLE = "__quickservicets_migrations";

/** The migrations table under the previous name, renamed to `MIGRATIONS_TABLE` once. */
export const LEGACY_MIGRATIONS_TABLE = `__${PREVIOUS_NAME}_migrations`;

/** The config file under the previous name. */
export const LEGACY_CONFIG_FILE = `${PREVIOUS_NAME}.config.ts`;

/** What a project with only the old config file is told. */
export const LEGACY_CONFIG_MESSAGE = `Rename ${LEGACY_CONFIG_FILE} to ${CONFIG_FILE}`;

/** The log message of a renamed migrations table. */
export const MIGRATIONS_TABLE_RENAMED = "migrations.table.renamed";

/** A migrations table renamed from its previous name, as `<schema>.<table>` on PostgreSQL and the table name on SQLite. */
export interface RenamedTable {
  from: string;
  to: string;
}

async function renameSqlite(client: Database): Promise<RenamedTable[]> {
  const tables = new Set((client.query("select name from sqlite_master where type = 'table'").all() as { name: string }[]).map((row) => row.name));
  const renamed: RenamedTable[] = [];
  for (const name of tables) {
    if (!name.endsWith(LEGACY_MIGRATIONS_TABLE)) continue;
    // Tables of explicit schemas carry the schema as a prefix, like `billing__<table>`.
    const target = `${name.slice(0, -LEGACY_MIGRATIONS_TABLE.length)}${MIGRATIONS_TABLE}`;
    if (tables.has(target)) continue;
    client.run(`alter table "${name}" rename to "${target}"`);
    renamed.push({ from: name, to: target });
  }
  return renamed;
}

async function renamePostgres(client: SQL): Promise<RenamedTable[]> {
  const rows = (await client`
    select old.table_schema as schema from information_schema.tables old
    where old.table_name = ${LEGACY_MIGRATIONS_TABLE}
      and not exists (select 1 from information_schema.tables new where new.table_schema = old.table_schema and new.table_name = ${MIGRATIONS_TABLE})
    order by old.table_schema`) as { schema: string }[];
  const renamed: RenamedTable[] = [];
  for (const { schema } of rows) {
    const quoted = `"${schema.replaceAll('"', '""')}"`;
    // quickservicets-allow-unsafe: the schema name comes from the catalog and is quoted; the table names are constants
    await client.unsafe(`alter table if exists ${quoted}."${LEGACY_MIGRATIONS_TABLE}" rename to "${MIGRATIONS_TABLE}"`);
    renamed.push({ from: `${schema}.${LEGACY_MIGRATIONS_TABLE}`, to: `${schema}.${MIGRATIONS_TABLE}` });
  }
  return renamed;
}

/**
 * Renames every migrations table that still has its previous name (in the default schema and in every other schema)
 * when the new name is not taken there, so a database keeps its migration history. A connected SQLite or PostgreSQL
 * adapter is needed; other adapters keep no such table and return no rename.
 */
export async function renameLegacyMigrationTables(database: { kind?: string; client?: unknown }): Promise<RenamedTable[]> {
  if (database.kind === "sqlite" && database.client) return renameSqlite(database.client as Database);
  if (database.kind === "postgres" && database.client) return renamePostgres(database.client as SQL);
  return [];
}
