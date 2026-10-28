import type { HookCall, HookDefinition, ServiceRequest } from "../hooks.ts";
import { entityRoutePath, type CrudOperation, type EntityModel } from "../model.ts";
import type { Endpoint } from "./server.ts";
import { startSpan, tracingEnabled, withSpan } from "../tracing.ts";

/** Runs a hook in an internal span named `hook <name>`, recording a thrown error. */
async function tracedHook<T>(name: string, run: () => T | Promise<T>): Promise<T> {
  const span = startSpan(`hook ${name}`, { kind: "internal" });
  try {
    return await withSpan(span, run);
  } catch (error) {
    span.recordException(error);
    span.setStatus("error");
    throw error;
  } finally {
    span.end();
  }
}

/** Derives the CRUD operation of a route on an entity, or undefined when the route is not a CRUD route. */
export function operationForRoute(
  entity: Pick<EntityModel, "name" | "schema">,
  method: string,
  pattern: string,
): CrudOperation | undefined {
  const collection = entityRoutePath(entity);
  const item = `${collection}/:`;
  const key = `${method.toUpperCase()} ${pattern}`;
  const operations: Record<string, CrudOperation> = {
    [`GET ${collection}`]: "list",
    [`GET ${item}`]: "read",
    [`POST ${collection}`]: "create",
    [`PATCH ${item}`]: "update",
    [`PUT ${item}`]: "replace",
    [`DELETE ${item}`]: "delete",
  };
  return operations[key];
}

export type RouteHookSource =
  | { kind: "generated"; entity: EntityModel; operation: CrudOperation }
  | { kind: "override"; entity: EntityModel; operation: CrudOperation; endpointHooks: HookCall[] }
  | { kind: "custom"; endpointHooks: HookCall[] };

const entityHooksFor = (entity: EntityModel, operation: CrudOperation): HookCall[] =>
  entity.hooks
    .filter((hook) => hook.operations.includes(operation))
    .map((hook) => ({ name: hook.name, args: hook.args }));

/** Computes the ordered hook list of a route from its entity hooks and its endpoint hooks. */
export function resolveRouteHooks(source: RouteHookSource): HookCall[] {
  if (source.kind === "generated") return entityHooksFor(source.entity, source.operation);
  if (source.kind === "custom" || source.entity.overrideHooks === "replace") return source.endpointHooks;
  const endpointNames = new Set(source.endpointHooks.map((hook) => hook.name));
  const inherited = entityHooksFor(source.entity, source.operation).filter((hook) => !endpointNames.has(hook.name));
  return [...inherited, ...source.endpointHooks];
}

const executed = new WeakMap<ServiceRequest, string[]>();

/** Names of the hooks executed so far for a request, in execution order. */
export function executedHooks(req: ServiceRequest): string[] {
  return executed.get(req) ?? [];
}

function record(req: ServiceRequest, name: string): void {
  const names = executed.get(req) ?? [];
  names.push(name);
  executed.set(req, names);
}

/** Wraps a handler so its pre-hooks run before it and its post-hooks transform its result. */
export function withHooks(handler: Endpoint, calls: HookCall[], registry: ReadonlyMap<string, HookDefinition>): Endpoint {
  const resolved = calls.map((call) => {
    const definition = registry.get(call.name);
    if (!definition) throw new Error(`Hook "${call.name}" is not registered`);
    return { call, definition };
  });
  if (resolved.length === 0) return handler;

  return async (repos, req, res) => {
    for (const { call, definition } of resolved) {
      if (definition.phase !== "pre") continue;
      record(req, call.name);
      if (tracingEnabled()) await tracedHook(call.name, () => definition.fn(repos, req, res, call.args));
      else await definition.fn(repos, req, res, call.args);
    }
    let result: unknown = await handler(repos, req, res);
    if (result instanceof Response || result === undefined) return result;
    for (const { call, definition } of resolved) {
      if (definition.phase !== "post") continue;
      record(req, call.name);
      const current = result;
      result = tracingEnabled() ? await tracedHook(call.name, () => definition.fn(current, repos, req, res, call.args)) : await definition.fn(result, repos, req, res, call.args);
    }
    return result;
  };
}
