import type { SQL } from "bun";

/** What an executor can do beyond single statements; features needing a missing one fail startup. */
export interface SqlExecutorCapabilities {
  /** Transactions with application work between their statements (`transaction(fn)`). */
  interactiveTransactions: boolean;
  /** LISTEN/NOTIFY on a session of its own. */
  listen: boolean;
  /** Server-side prepared statements. */
  preparedStatements: boolean;
}

/** The capabilities an executor may lack, as features name them. */
export type SqlExecutorCapability = keyof SqlExecutorCapabilities;

/** Options of one statement. */
export interface SqlQueryOptions {
  /** Rejects the statement with an `AbortError` once aborted; one aborted before it is sent is never sent. */
  signal?: AbortSignal;
}

/**
 * How the PostgreSQL adapter's statements reach the database: the built-in one sends them over `Bun.SQL`, and HTTP
 * drivers or managed APIs implement it to reuse every query, migration and contract of the adapter. Errors carry the
 * PostgreSQL error code (SQLSTATE) as `code`, and the constraint as `constraint` when there is one.
 */
export interface SqlExecutor {
  readonly name: string;
  readonly capabilities: SqlExecutorCapabilities;
  /** Runs one statement with `$1`-style parameters and resolves its rows as objects. */
  query(text: string, params: readonly unknown[], options?: SqlQueryOptions): Promise<Record<string, unknown>[]>;
  /** Runs `fn` with an executor bound to one session, committing when it resolves and rolling back when it throws. */
  transaction<T>(fn: (executor: SqlExecutor) => Promise<T>): Promise<T>;
  /** Closes the executor's connections. */
  close(): Promise<void>;
}

/** The error of a statement aborted through its signal. */
export function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  return Object.assign(new Error("The statement was aborted"), { name: "AbortError", cause: reason });
}

/** Races a statement with its signal: an aborted statement rejects with an `AbortError` at once. */
export function withSignal<T>(signal: AbortSignal | undefined, send: () => Promise<T>): Promise<T> {
  if (!signal) return send();
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    signal.addEventListener("abort", abort, { once: true });
    send().then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/**
 * Gives a `Bun.SQL` server error its PostgreSQL error code (SQLSTATE, Bun's `errno`) as `code`, as every executor
 * reports it; Bun's own code stays as `driverCode`. Other errors are rethrown as they are.
 */
export function withSqlState(error: unknown): never {
  const failure = error as { code?: unknown; errno?: unknown } | null;
  if (failure && typeof failure === "object" && failure.code === "ERR_POSTGRES_SERVER_ERROR" && typeof failure.errno === "string" && /^[0-9A-Z]{5}$/.test(failure.errno)) {
    try {
      Object.defineProperty(failure, "driverCode", { value: failure.code, enumerable: false, configurable: true, writable: true });
      Object.defineProperty(failure, "code", { value: failure.errno, enumerable: true, configurable: true, writable: true });
    } catch {
      // A frozen error keeps Bun's code; the adapter's mapping also reads errno.
    }
  }
  throw error;
}

/** The capabilities of the built-in executor. */
const BUN_SQL_CAPABILITIES: SqlExecutorCapabilities = Object.freeze({ interactiveTransactions: true, listen: true, preparedStatements: true });

/** The built-in executor: statements over a `Bun.SQL` pool or one of its transactions. */
export function bunSqlExecutor(sql: SQL, options: { prepare?: boolean } = {}): SqlExecutor {
  const capabilities = options.prepare === false ? Object.freeze({ ...BUN_SQL_CAPABILITIES, preparedStatements: false }) : BUN_SQL_CAPABILITIES;
  const executor: SqlExecutor & { readonly sql: SQL } = {
    name: "bun-sql",
    capabilities,
    sql,
    query(text, params, queryOptions) {
      // quickservicets-allow-unsafe: the adapter's statements, with their values as parameters
      const send = () => (sql.unsafe(text, params as unknown[]) as unknown as Promise<Record<string, unknown>[]>).then(undefined, withSqlState);
      return queryOptions?.signal ? withSignal(queryOptions.signal, send) : send();
    },
    transaction(fn) {
      return sql.begin((tx) => fn(bunSqlExecutor(tx as unknown as SQL, options))) as Promise<never>;
    },
    close: () => sql.close(),
  };
  return executor;
}

/** The `Bun.SQL` client of a built-in executor, undefined for other executors. */
export const bunSqlOf = (executor: SqlExecutor): SQL | undefined => (executor as { sql?: SQL }).sql;

/** A query of an executor client: the rows as a promise, with `values()` for rows as arrays like `Bun.SQL`'s. */
type ClientQuery = Promise<Record<string, unknown>[]> & { values(): Promise<unknown[][]> };

/**
 * A `Bun.SQL`-shaped client over an executor, for the code that takes a client (Drizzle, migrations, the legacy
 * table renames): `unsafe(text, params)` with `values()`, tagged templates, `begin`, `savepoint` and `close`.
 */
export function executorClient(executor: SqlExecutor): SQL {
  let savepoints = 0;
  const query = (text: string, params: readonly unknown[] = []): ClientQuery => {
    let rows: Promise<Record<string, unknown>[]> | undefined;
    const run = () => (rows ??= executor.query(text, params));
    const lazy = {
      then: (resolve: never, reject: never) => run().then(resolve, reject),
      catch: (reject: never) => run().catch(reject),
      finally: (done: never) => run().finally(done),
      values: async () => (await run()).map((row) => Object.values(row)),
    };
    return lazy as unknown as ClientQuery;
  };
  const template = (strings: TemplateStringsArray, ...values: unknown[]) =>
    query(
      strings.reduce((text, part, index) => text + (index > 0 ? `$${index}` : "") + part, ""),
      values,
    );
  return Object.assign(template, {
    unsafe: (text: string, params?: readonly unknown[]) => query(text, params ?? []),
    begin: (fn: (tx: SQL) => Promise<unknown>) => executor.transaction((tx) => fn(executorClient(tx))),
    async savepoint(fn: (tx: SQL) => Promise<unknown>) {
      const name = `qs_savepoint_${++savepoints}`;
      await executor.query(`savepoint ${name}`, []);
      try {
        const result = await fn(executorClient(executor));
        await executor.query(`release savepoint ${name}`, []);
        return result;
      } catch (error) {
        await executor.query(`rollback to savepoint ${name}`, []);
        throw error;
      }
    },
    close: () => executor.close(),
    executor,
  }) as unknown as SQL;
}

/** The startup failure of a feature needing a capability the executor lacks. */
export const missingCapability = (feature: string, capability: SqlExecutorCapability, executor: string) =>
  `${feature} needs ${capability}, which the ${executor} executor does not support`;

/**
 * Fails when an enabled feature needs a capability the default database's executor lacks, with
 * `<feature> needs <capability>, which the <name> executor does not support`.
 */
export function assertSqlCapabilities(
  features: readonly { key: string; options: unknown; definition: { sqlCapabilities?: readonly SqlExecutorCapability[] | ((options: never) => readonly SqlExecutorCapability[]) } }[],
  database: unknown,
): void {
  const adapter = (database as { databases?: Record<string, unknown> }).databases?.default ?? database;
  const executor = (adapter as { kind?: unknown; executor?: SqlExecutor } | undefined)?.kind === "postgres" ? (adapter as { executor?: SqlExecutor }).executor : undefined;
  if (!executor) return;
  for (const { key, options, definition } of features) {
    const declared = definition.sqlCapabilities;
    const needed = typeof declared === "function" ? declared(options as never) : (declared ?? []);
    for (const capability of needed) if (!executor.capabilities[capability]) throw new Error(missingCapability(key, capability, executor.name));
  }
}
