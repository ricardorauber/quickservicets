import { databaseAdapters, defineCommand, secretValue, type CommandContext, type DatabaseAdapter, type ResolvedConfig, type SecretReference } from "../public.ts";

/** The options `db check` reads, a subset of the native's. */
interface CheckOptions {
  mode: "auto" | "server" | "serverless";
  proxy: "none" | "pgbouncer" | "rds-proxy";
  direct?: string | SecretReference;
}

/** What `db check` found: the lines it prints and whether a check failed. */
export interface DatabaseCheckResult {
  lines: string[];
  failed: boolean;
}

/** Hides the password of every connection URL in a text, and the given secret texts. */
export function redactCredentials(text: string, secrets: readonly string[] = []): string {
  let redacted = text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^:/?#@\s]*:)[^@/\s]*@/gi, "$1[secret]@");
  for (const value of secrets) if (value.length >= 4) redacted = redacted.split(value).join("[secret]");
  return redacted;
}

const passwordOf = (url: string): string | undefined => {
  try {
    const password = decodeURIComponent(new URL(url).password);
    return password === "" ? undefined : password;
  } catch {
    return undefined;
  }
};

const messageOf = (error: unknown) => (error as Error)?.message ?? String(error);

/** Opens one PostgreSQL connection with the proxy's statement settings, runs `work` on it and closes it. */
async function withPostgres<T>(url: string, options: CheckOptions, work: (sql: InstanceType<typeof Bun.SQL>) => Promise<T>): Promise<T> {
  const sql = new Bun.SQL({ url, max: 1, ...(options.proxy !== "none" ? { prepare: false } : {}), ...(options.proxy === "rds-proxy" ? { tls: true } : {}) } as never);
  try {
    return await work(sql);
  } finally {
    await sql.close().catch(() => {});
  }
}

/** The kind, version and connection counts of one database, as printed lines. */
async function describeDatabase(adapter: DatabaseAdapter, options: CheckOptions): Promise<string[]> {
  if (adapter.kind === "postgres") {
    const url = secretValue((adapter as unknown as { url: string }).url);
    const [row] = await withPostgres(url, options, (sql) =>
      sql.unsafe("select current_setting('server_version') as version, current_setting('max_connections')::int as max, (select count(*)::int from pg_stat_activity) as current"),
    );
    return [`database: PostgreSQL ${row.version}`, `max_connections: ${row.max}`, `connections: ${row.current} open`];
  }
  if (adapter.kind === "mongodb") {
    await adapter.connect([], {});
    try {
      const admin = (adapter as unknown as { db: { admin(): { command(command: object): Promise<Record<string, any>> } } }).db.admin();
      const info = await admin.command({ buildInfo: 1 });
      const lines = [`database: MongoDB ${info.version}`];
      const status = await admin.command({ serverStatus: 1 }).catch(() => undefined);
      if (status?.connections) lines.push(`connections: ${status.connections.current} open, ${status.connections.available} available`);
      return lines;
    } finally {
      await adapter.disconnect();
    }
  }
  return [`database: ${adapter.kind}`];
}

/** The pool settings in effect for a database, as `db check` prints them. */
function poolLine(settings: Record<string, unknown> | undefined): string {
  const shown = Object.entries(settings ?? {}).filter(([key, value]) => key !== "direct" && key !== "onReconnect" && value !== undefined);
  return shown.length === 0 ? "pool: the adapter's own" : `pool: ${shown.map(([key, value]) => `${key} ${value}`).join(", ")}`;
}

/**
 * Connects to each configured database and reports its kind and version, the pool settings in effect, the connection
 * counts, whether `direct` works and every problem the proxy settings have. Credentials never appear in the lines.
 */
export async function checkDatabases(
  config: ResolvedConfig,
  options: CheckOptions,
  context: { pools: (database: string) => Record<string, unknown> | undefined; problems: string[] },
): Promise<DatabaseCheckResult> {
  const lines: string[] = [];
  let failed = false;
  const adapters = databaseAdapters(config.database);
  const secrets: string[] = [];
  for (const [, adapter] of adapters) {
    try {
      const url = (adapter as { url?: unknown }).url;
      const password = typeof url === "string" ? passwordOf(url) : undefined;
      if (password) secrets.push(password);
    } catch {
      // An unresolved secret has no text to hide.
    }
  }
  const direct = options.direct === undefined ? undefined : secretValue(options.direct);
  const directPassword = direct ? passwordOf(direct) : undefined;
  if (directPassword) secrets.push(directPassword);
  for (const [name, adapter] of adapters) {
    const prefix = adapters.length > 1 ? `${name}: ` : "";
    try {
      for (const line of await describeDatabase(adapter, options)) lines.push(prefix + line);
    } catch (error) {
      failed = true;
      lines.push(`${prefix}database: ${adapter.kind} cannot be reached (${redactCredentials(messageOf(error), secrets)})`);
    }
    lines.push(prefix + poolLine(context.pools(name)));
  }
  if (options.proxy !== "none") lines.push(`proxy: ${options.proxy} (prepared statements off${options.proxy === "rds-proxy" ? ", TLS required" : ""})`);
  if (direct === undefined) lines.push("direct: not set");
  else {
    try {
      await withPostgres(direct, { ...options, proxy: "none" }, (sql) => sql.unsafe("select 1"));
      lines.push("direct: works");
    } catch (error) {
      failed = true;
      lines.push(`direct: fails (${redactCredentials(messageOf(error), secrets)})`);
    }
  }
  for (const problem of context.problems) {
    failed = true;
    lines.push(`problem: ${problem}`);
  }
  return { lines: lines.map((line) => redactCredentials(line, secrets)), failed };
}

/** `quickservicets db check`, registered by the `connections` native. */
export const dbCheckCommand = defineCommand({
  name: "db check",
  usage: "quickservicets db check",
  description:
    "Connects with the project's config and prints each database's kind and version, the pool settings in effect, max_connections and the open connections on PostgreSQL, whether connections.direct works, and one line per feature the connection proxy cannot carry; exits 1 when a check fails. Passwords are never printed.",
  async run(ctx: CommandContext) {
    // Loaded on demand: the native's module imports this one.
    const { poolSettingsFor, proxyProblems, proxySettings, resolveConnectionMode } = await import("./index.ts");
    const options = ctx.options as unknown as Parameters<typeof proxyProblems>[0] & Parameters<typeof poolSettingsFor>[0];
    const target = (ctx.config.features.find((feature) => feature.key === "deploy")?.options as { target?: string } | undefined)?.target ?? process.env.QS_DEPLOY_TARGET;
    const mode = resolveConnectionMode(options.mode, target);
    const result = await checkDatabases(ctx.config, options, {
      pools: (name) => {
        const adapter = databaseAdapters(ctx.config.database).find(([entry]) => entry === name)?.[1];
        const extra = adapter?.kind === "postgres" ? proxySettings(options) : undefined;
        const settings = { ...poolSettingsFor(options, name, mode), ...extra };
        return Object.keys(settings).length > 0 ? settings : undefined;
      },
      problems: proxyProblems(options, ctx.config),
    });
    for (const line of result.lines) ctx.output.log(line);
    return result.failed ? 1 : 0;
  },
});
