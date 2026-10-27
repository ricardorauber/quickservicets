import type { ServiceRequest } from "./hooks.ts";
import type { RepositoryRegistry } from "./repository.ts";
import { activeSetup } from "./setup-phase.ts";
import { currentDatabaseScope, databaseScopesEnabled } from "./database-scope.ts";

/** What a job run, a queue message or a listener run is for, as `resolveRunRepositories` receives it. */
export interface RunTarget {
  job?: { name: string; runId: string };
  queue?: { name: string; messageId: string };
  /** The tenant the run is for, when known. */
  tenant?: string;
}

/** Chooses the repositories of each request, and of runs outside requests. */
export interface RepositoryResolver {
  /** The key of the feature that set it. */
  owner: string;
  /** The registry the hooks and handler of a request receive. */
  request: (req: ServiceRequest) => RepositoryRegistry;
  /** The registry of a job, consumer or listener run (default: the startup registry). */
  run?: (run: RunTarget) => RepositoryRegistry;
}

/** Options of `setRepositoryResolver`. */
export interface RepositoryResolverOptions {
  /** Chooses the registry of jobs, queue consumers and listener files (default: the startup registry). */
  run?: (run: RunTarget) => RepositoryRegistry;
}

/**
 * Makes the pipeline pass `fn(req)` to the hooks and handler of every request instead of the startup registry, and
 * `options.run` to jobs, queue consumers and listener files. Only one feature may set it, during its setup.
 */
export function setRepositoryResolver(fn: (req: ServiceRequest) => RepositoryRegistry, options: RepositoryResolverOptions = {}): void {
  const setup = activeSetup();
  if (!setup) throw new Error("setRepositoryResolver() is only available during feature setup");
  if (typeof fn !== "function") throw new Error("setRepositoryResolver() takes a function of the request");
  const current = setup.server.repositories;
  if (current) throw new Error(`A repository resolver is already set by ${current.owner}`);
  setup.server.repositories = { owner: setup.feature, request: fn, ...(options.run ? { run: options.run } : {}) };
}

interface RunState {
  root?: RepositoryRegistry;
  resolver?: RepositoryResolver;
}

let runs: RunState = {};

/** Sets the startup registry and the resolver runs use; `createApp` calls it. */
export function configureRunRepositories(root: RepositoryRegistry, resolver: RepositoryResolver | undefined): void {
  runs = { root, ...(resolver ? { resolver } : {}) };
}

/**
 * The repositories of a job run, a queue consumer or a listener file: the resolver's choice when a feature set one with
 * a `run` function, the startup registry otherwise (or `fallback`'s when given, for code that holds its own).
 */
export function resolveRunRepositories(run: RunTarget = {}, fallback?: () => RepositoryRegistry): RepositoryRegistry {
  const resolver = runs.resolver;
  if (resolver?.run) return resolver.run(run);
  if (databaseScopesEnabled()) return currentDatabaseScope().repos;
  if (fallback) return fallback();
  if (!runs.root) throw new Error("resolveRunRepositories() needs a running service: no repositories are configured yet");
  return runs.root;
}
