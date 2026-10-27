import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseAdapter } from "./adapter.ts";
import { databaseScopesEnabled, scopedAdapter, scopeKeyOf, sharesConnection } from "./database-scope.ts";
import { jsonLogger, safeLog, type Logger } from "./logger.ts";

/** One open transaction: the adapter it runs on and the callbacks queued for its end. */
interface TransactionScope {
  adapter: DatabaseAdapter;
  afterCommit: (() => unknown)[];
  onRollback: (() => unknown)[];
}

const scopes = new AsyncLocalStorage<TransactionScope>();

interface TransactionSettings {
  adapter?: DatabaseAdapter;
  logger: Logger;
}

const settings: TransactionSettings = { logger: jsonLogger };
/** Adapters without rollback that a public transaction already warned about. */
const warned = new WeakSet<DatabaseAdapter>();

/** Sets the database `transaction` and `repos.transaction` run on, and the logger of callback failures; `createApp` calls it. */
export function configureTransactions(adapter: DatabaseAdapter, logger: Logger = jsonLogger): void {
  settings.adapter = adapter;
  settings.logger = logger;
}

const log = (level: "warn" | "error", message: string, error?: unknown) =>
  safeLog(settings.logger, level, {
    timestamp: new Date().toISOString(),
    message,
    ...(error === undefined ? {} : { error: { message: (error as Error)?.message ?? String(error), ...(error instanceof Error ? { stack: error.stack } : {}) } }),
  });

/** Runs callbacks one after the other, logging each failure under `message` without stopping. */
async function runCallbacks(callbacks: readonly (() => unknown)[], message: string): Promise<void> {
  for (const callback of callbacks) {
    try {
      await callback();
    } catch (error) {
      log("error", message, error);
    }
  }
}

/**
 * Runs `fn` in one database transaction on `adapter`, or inside the transaction already open on it (no savepoint).
 * The outermost call runs the `afterCommit` callbacks after the commit, in order and awaited, or the `onRollback`
 * callbacks after a rollback, then rejects with the error. The core's own multi-statement writes use it too.
 */
export async function runInTransaction<T>(adapter: DatabaseAdapter, fn: () => Promise<T>): Promise<T> {
  const current = scopes.getStore();
  if (current && (current.adapter === adapter || sharesConnection(current.adapter, adapter))) return fn();
  if (current && databaseScopesEnabled()) throw crossScopeWrite(adapter, current.adapter);
  const scope: TransactionScope = { adapter, afterCommit: [], onRollback: [] };
  let result: T;
  try {
    result = await adapter.transaction(() => scopes.run(scope, fn));
  } catch (error) {
    await runCallbacks(scope.onRollback, "transaction.on-rollback.failed");
    throw error;
  }
  await runCallbacks(scope.afterCommit, "transaction.after-commit.failed");
  return result;
}

/**
 * Runs `fn` in one database transaction: every repository call inside it (through `repos`, `req`, hooks or any module)
 * takes part, a throw rolls everything back and rejects with the error, and a call inside another transaction joins it.
 * Resolves with `fn`'s result once the `afterCommit` callbacks ran.
 */
export function transaction<T>(fn: () => Promise<T>): Promise<T> {
  const adapter = settings.adapter && scopedAdapter(settings.adapter);
  if (!adapter) return Promise.reject(new Error("transaction() needs a running service: no database is configured yet"));
  return publicTransaction(adapter, fn);
}

/** A transaction started by project or feature code, which warns once when the database cannot roll back. */
export function publicTransaction<T>(adapter: DatabaseAdapter, fn: () => Promise<T>): Promise<T> {
  if (adapter.supportsRollback !== true && !warned.has(adapter)) {
    warned.add(adapter);
    log("warn", "transactions are not atomic on this database; writes in a failed transaction are kept");
  }
  return runInTransaction(adapter, fn);
}

/**
 * Queues `fn` to run after the outermost transaction commits, in registration order; a failing callback is logged as
 * `transaction.after-commit.failed` and does not fail the transaction. Outside a transaction, runs `fn` at once and
 * returns its promise.
 */
export function afterCommit(fn: () => unknown): Promise<void> {
  const scope = scopes.getStore();
  if (scope) {
    scope.afterCommit.push(fn);
    return Promise.resolve();
  }
  try {
    return Promise.resolve(fn()).then(() => undefined);
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Queues `fn` to run after the outermost transaction rolls back, in registration order, with failures logged as
 * `transaction.on-rollback.failed`. Does nothing outside a transaction.
 */
export function onRollback(fn: () => unknown): void {
  scopes.getStore()?.onRollback.push(fn);
}

const crossScopeWrite = (target: DatabaseAdapter, open: DatabaseAdapter) =>
  new Error(`Cannot write to ${scopeKeyOf(target)} inside a transaction of ${scopeKeyOf(open)}; they use different databases`);

/**
 * Throws when a write through `adapter` would happen inside a transaction of another database scope that does not
 * share its connection, since that transaction could not include it. Does nothing while database scopes are off.
 */
export function assertWritable(adapter: DatabaseAdapter): void {
  if (!databaseScopesEnabled()) return;
  const current = scopes.getStore();
  if (current && !sharesConnection(current.adapter, adapter)) throw crossScopeWrite(adapter, current.adapter);
}

/** An object that stands for the transaction the caller runs in (the same one for all its code), or undefined. */
export function currentTransaction(): object | undefined {
  return scopes.getStore();
}

/** Whether the caller runs inside a transaction. */
export function inTransaction(): boolean {
  return scopes.getStore() !== undefined;
}
