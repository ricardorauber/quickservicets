import { AsyncLocalStorage } from "node:async_hooks";
import type { ServiceRequest } from "./hooks.ts";
import type { HandlerMiddleware } from "./middleware.ts";

/** What the current code runs for: a request, a job run or a queue message. */
export interface OperationInfo {
  requestId?: string;
  req?: ServiceRequest;
  job?: { name: string; runId: string };
  queue?: { name: string; messageId: string };
  /** The key of the database scope the code runs in, set by `withDatabaseScope` (`tenant:<id>` for tenants). */
  scope?: string;
}

const operations = new AsyncLocalStorage<OperationInfo>();
let enabled = false;

/**
 * Turns the operation context on: from then on every request, job run and on-demand job run runs inside
 * `withOperation`, so `currentOperation()` tells what the current code runs for. Until called, nothing is tracked.
 */
export function enableOperationContext(): void {
  enabled = true;
}

/** Turns the operation context off again; for tests and features that stop. */
export function disableOperationContext(): void {
  enabled = false;
}

/** Whether the operation context is on. */
export function operationContextEnabled(): boolean {
  return enabled;
}

/** Runs `fn` as the operation `info`; `currentOperation()` returns it inside `fn` and everything it awaits. */
export function withOperation<T>(info: OperationInfo, fn: () => T): T {
  return operations.run(info, fn);
}

/** The operation the caller runs for, or undefined outside one or while the context is off. */
export function currentOperation(): OperationInfo | undefined {
  return enabled ? operations.getStore() : undefined;
}

/** Runs a job run's code inside its operation when the context is on, or directly otherwise. */
export function withJobOperation<T>(job: { name: string; runId: string }, fn: () => T): T {
  return enabled ? operations.run({ job }, fn) : fn();
}

/**
 * The handler middleware that runs each request inside its operation, outermost of the handler stage; features that
 * enable the operation context add it to their `middleware`.
 */
export const operationMiddleware: HandlerMiddleware = {
  stage: "handler",
  order: -100_000,
  run: (req, _res, next) => (enabled ? operations.run({ requestId: req.id, req }, next) : next()),
};
