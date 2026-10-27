import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseAdapter } from "./adapter.ts";
import type { EntityModel } from "./model.ts";
import { currentOperation, operationContextEnabled, withOperation } from "./operation-context.ts";
import { repositoriesFor, type RepositoryRegistry } from "./repository.ts";
import { activeSetup } from "./setup-phase.ts";

/** The tenant a database scope serves. */
export interface ScopeTenant {
  id: string;
  [key: string]: unknown;
}

/**
 * The database the code of a request or a run uses: its adapter and repositories. `key` is a stable text: `root` for
 * the startup database, `tenant:<id>` for tenants.
 */
export interface DatabaseScope {
  key: string;
  adapter: DatabaseAdapter;
  repos: RepositoryRegistry;
  tenant?: ScopeTenant;
  /**
   * Where the core writes its own rows (queue messages, outbox events and deliveries) for this scope, when not through
   * `adapter`: a tenant with a database of its own stages them there inside its transactions and writes them to the
   * service's database otherwise.
   */
  systemRows?: (model: EntityModel) => { adapter: DatabaseAdapter; model: EntityModel };
}

/** What `withDatabaseScope` takes: a scope whose `repos` default to `repositoriesFor(adapter)`. */
export type DatabaseScopeInput = Omit<DatabaseScope, "repos"> & { repos?: RepositoryRegistry };

/** The async context of database scopes; created by `enableDatabaseScopes`, so nothing is tracked until a feature asks. */
let scopes: AsyncLocalStorage<DatabaseScope> | undefined;
let root: DatabaseScope | undefined;
/** The scope key of each adapter a scope used, so the guard against mixing databases can name both sides. */
const keys = new WeakMap<DatabaseAdapter, string>();

/**
 * Sets the root scope (the startup database and registry) and whether scopes are on; `createApp` calls it with what
 * the features' setups asked for, so each service starts from its own state.
 */
export function configureDatabaseScopes(adapter: DatabaseAdapter, repos: RepositoryRegistry, enabled: boolean): void {
  root = { key: "root", adapter, repos };
  keys.set(adapter, "root");
  scopes = enabled ? (scopes ?? new AsyncLocalStorage<DatabaseScope>()) : undefined;
}

/**
 * Turns database scopes on for the service being set up: `withDatabaseScope` works from then on, and the core's global
 * database functions follow the current scope. Only available during a feature's setup.
 */
export function enableDatabaseScopes(): void {
  const setup = activeSetup();
  if (!setup) throw new Error("enableDatabaseScopes() is only available during feature setup");
  setup.server.databaseScopes = true;
  scopes ??= new AsyncLocalStorage<DatabaseScope>();
}

/** Whether database scopes are on. */
export function databaseScopesEnabled(): boolean {
  return scopes !== undefined;
}

function rootScope(): DatabaseScope {
  if (!root) throw new Error("No database scope: the service has not started yet");
  return root;
}

/**
 * Runs `fn` with `scope` active for every async continuation: the global database functions (`transaction`,
 * `afterCommit`, `queues.add`, `events.emit`, …) and the repositories handed to hooks, handlers and runs use its
 * adapter. Throws `Database scopes are not enabled` until a feature called `enableDatabaseScopes()`.
 */
export function withDatabaseScope<T>(input: DatabaseScopeInput, fn: () => T): T {
  if (!scopes) throw new Error("Database scopes are not enabled");
  const scope: DatabaseScope = input.repos ? (input as DatabaseScope) : { ...input, repos: repositoriesFor(input.adapter) };
  if (!keys.has(scope.adapter)) keys.set(scope.adapter, scope.key);
  const store = scopes;
  if (!operationContextEnabled()) return store.run(scope, fn);
  return store.run(scope, () => withOperation({ ...(currentOperation() ?? {}), scope: scope.key }, fn));
}

/** The innermost active scope, or the root scope; without scopes enabled it never reads the async context. */
export function currentDatabaseScope(): DatabaseScope {
  if (!scopes) return rootScope();
  return scopes.getStore() ?? rootScope();
}

/**
 * The adapter the current scope uses in place of `adapter`, the root adapter a native captured at setup: the scope's
 * own inside a scope, `adapter` itself outside one or while scopes are off.
 */
export function scopedAdapter(adapter: DatabaseAdapter): DatabaseAdapter {
  if (!scopes) return adapter;
  return scopes.getStore()?.adapter ?? adapter;
}

/**
 * Where a core row of `model` (a queue message, an outbox row) goes from the current scope: `adapter` (the root one a
 * native captured) outside scopes, the scope's own target when it has one, the scope's adapter otherwise.
 */
export function systemTarget(adapter: DatabaseAdapter, model: EntityModel): { adapter: DatabaseAdapter; model: EntityModel } {
  if (!scopes) return { adapter, model };
  const scope = scopes.getStore();
  if (!scope) return { adapter, model };
  return scope.systemRows?.(model) ?? { adapter: scope.adapter, model };
}

/** The scope key an adapter was used with, or a generic name for an adapter no scope used. */
export function scopeKeyOf(adapter: DatabaseAdapter): string {
  return keys.get(adapter) ?? "another database";
}

/** Whether two adapters reach the same connection, so one transaction covers writes through both. */
export function sharesConnection(a: DatabaseAdapter, b: DatabaseAdapter): boolean {
  return a === b || a.sharesConnectionWith?.(b) === true || b.sharesConnectionWith?.(a) === true;
}
