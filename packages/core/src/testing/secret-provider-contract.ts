import { test } from "bun:test";
import { isSecretAccessError, isSecretNotFoundError, parseSecretReference } from "../secret-references.ts";
import type { SecretProvider } from "../features/secrets/api.ts";
import { providerRegistry, resolveReference } from "../features/secrets/resolve.ts";

/** What a provider's tests give the contract: references the provider's fixtures answer, usually through `http.mock()`. */
export interface SecretProviderFixtures {
  /** A reference without a key, and the value it resolves to. */
  value: { reference: string; value: string };
  /** A reference with `#key`, and the value of that key. */
  key: { reference: string; value: string };
  /** A reference with `?version=<version>`, the value of that version and the version the provider reports. */
  version: { reference: string; value: string; version: string };
  /** A reference to a secret that does not exist. */
  missing: string;
  /** A reference the vault refuses to read. */
  denied: string;
  /** A reference whose resolution only ends when its signal aborts, like a vault that never answers. */
  slow: string;
  /** The HTTP mock answering the provider's calls, whose calls must each go through a registered service. */
  http?: { readonly calls: readonly { service?: string }[] };
}

/** What `runSecretProviderContract` takes besides the provider factory. */
export interface SecretProviderContractOptions {
  /** Shown in the test titles (default: the provider's `name`, or its schemes). */
  name?: string;
  fixtures: SecretProviderFixtures | (() => SecretProviderFixtures | Promise<SecretProviderFixtures>);
}

type Create = () => SecretProvider | Promise<SecretProvider>;

/** One check of the contract. */
export interface SecretProviderCheck {
  name: string;
  run(create: Create, fixtures: SecretProviderFixtures): Promise<void>;
}

const fail = (message: string): never => {
  throw new Error(message);
};

/** The values of the fixtures, which no error message may hold. */
const valuesOf = (fixtures: SecretProviderFixtures) => [fixtures.value.value, fixtures.key.value, fixtures.version.value].filter((value) => value.length >= 4);

async function resolved(provider: SecretProvider, text: string) {
  const registry = providerRegistry();
  registry.add(provider, "the contract");
  return resolveReference(registry, parseSecretReference(text), { timeout: 5000, retries: 0 });
}

/** Resolves the provider's answer to `text` directly, with a signal of its own. */
async function direct(provider: SecretProvider, text: string, signal = new AbortController().signal) {
  return provider.resolve(parseSecretReference(text), { signal });
}

/** Expects `text` to fail with the given error kind and message, holding no fixture value. */
async function expectFailure(provider: SecretProvider, fixtures: SecretProviderFixtures, text: string, kind: "not found" | "access denied") {
  let error: unknown;
  try {
    await direct(provider, text);
  } catch (caught) {
    error = caught;
  }
  if (error === undefined) fail(`${text} resolved; expected ${kind === "not found" ? "SecretNotFoundError" : "SecretAccessError"}`);
  const matches = kind === "not found" ? isSecretNotFoundError(error) : isSecretAccessError(error);
  if (!matches) fail(`${text} failed with ${(error as Error)?.name ?? typeof error}; expected ${kind === "not found" ? "SecretNotFoundError" : "SecretAccessError"}`);
  const message = (error as Error).message;
  if (message !== `${text}: ${kind}`) fail(`the error message is ${JSON.stringify(message)}; expected "${text}: ${kind}"`);
  for (const value of valuesOf(fixtures)) if (JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(value) || String((error as Error).stack ?? "").includes(value)) fail(`the error of ${text} holds a secret value`);
}

/** Records the timers created while `work` runs and resolves those still active after it. */
export async function activeTimers(work: () => Promise<void>): Promise<number> {
  const saved = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval, clearTimeout: globalThis.clearTimeout, clearInterval: globalThis.clearInterval };
  const active = new Set<unknown>();
  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const handle = saved.setTimeout((...values: unknown[]) => {
      active.delete(handle);
      handler(...values);
    }, ms, ...args);
    active.add(handle);
    return handle;
  }) as typeof setTimeout;
  globalThis.setInterval = ((handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const handle = saved.setInterval(handler, ms, ...args);
    active.add(handle);
    return handle;
  }) as typeof setInterval;
  globalThis.clearTimeout = ((handle: unknown) => (active.delete(handle), saved.clearTimeout(handle as never))) as typeof clearTimeout;
  globalThis.clearInterval = ((handle: unknown) => (active.delete(handle), saved.clearInterval(handle as never))) as typeof clearInterval;
  try {
    await work();
  } finally {
    Object.assign(globalThis, saved);
  }
  for (const handle of active) saved.clearInterval(handle as never);
  return active.size;
}

/** Every check the contract runs, in order. */
export const SECRET_PROVIDER_CHECKS: readonly SecretProviderCheck[] = [
  {
    name: "resolves a value and a key",
    async run(create, fixtures) {
      const provider = await create();
      try {
        const value = await resolved(provider, fixtures.value.reference);
        if (value.value !== fixtures.value.value) fail(`${fixtures.value.reference} resolved to another value`);
        const key = await resolved(provider, fixtures.key.reference);
        if (key.value !== fixtures.key.value) fail(`${fixtures.key.reference} resolved to another value`);
      } finally {
        await provider.close?.();
      }
    },
  },
  {
    name: "resolves the pinned version and reports it",
    async run(create, fixtures) {
      const provider = await create();
      try {
        if (parseSecretReference(fixtures.version.reference).version === undefined) fail(`the version fixture ${fixtures.version.reference} has no ?version=`);
        const result = await resolved(provider, fixtures.version.reference);
        if (result.value !== fixtures.version.value) fail(`${fixtures.version.reference} resolved to another value`);
        if (result.version !== fixtures.version.version) fail(`${fixtures.version.reference} reported version ${JSON.stringify(result.version)}; expected ${JSON.stringify(fixtures.version.version)}`);
      } finally {
        await provider.close?.();
      }
    },
  },
  {
    name: "reports a missing secret with SecretNotFoundError, without values",
    async run(create, fixtures) {
      const provider = await create();
      try {
        await expectFailure(provider, fixtures, fixtures.missing, "not found");
      } finally {
        await provider.close?.();
      }
    },
  },
  {
    name: "reports a refused access with SecretAccessError, without values",
    async run(create, fixtures) {
      const provider = await create();
      try {
        await expectFailure(provider, fixtures, fixtures.denied, "access denied");
      } finally {
        await provider.close?.();
      }
    },
  },
  {
    name: "aborts its request when the signal aborts",
    async run(create, fixtures) {
      const provider = await create();
      try {
        const controller = new AbortController();
        const work = Promise.resolve().then(() => direct(provider, fixtures.slow, controller.signal));
        work.catch(() => {});
        setTimeout(() => controller.abort(new Error("timed out")), 50);
        const outcome = await Promise.race([work.then(() => "resolved", () => "rejected"), Bun.sleep(1000).then(() => "pending")]);
        if (outcome === "pending") fail("the provider ignores the abort signal: its resolution was still pending 1 second after the abort");
        if (outcome === "resolved") fail(`${fixtures.slow} resolved after the abort; expected a rejection`);
      } finally {
        await provider.close?.();
      }
    },
  },
  {
    name: "answers health() when it has one",
    async run(create) {
      const provider = await create();
      try {
        if (provider.health) await provider.health();
      } finally {
        await provider.close?.();
      }
    },
  },
  {
    name: "leaves no timers after close()",
    async run(create, fixtures) {
      const left = await activeTimers(async () => {
        const provider = await create();
        await resolved(provider, fixtures.value.reference);
        await provider.close?.();
      });
      if (left > 0) fail(`${left} timer${left === 1 ? " is" : "s are"} still active after close()`);
    },
  },
  {
    name: "calls HTTP only through a registered service",
    async run(create, fixtures) {
      const provider = await create();
      if ((provider as { transport?: string }).transport === "sdk") return void (await provider.close?.());
      const realFetch = globalThis.fetch;
      let direct = 0;
      globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
        direct++;
        return realFetch(...args);
      }) as typeof fetch;
      const before = fixtures.http?.calls.length ?? 0;
      try {
        await resolved(provider, fixtures.value.reference);
      } finally {
        globalThis.fetch = realFetch;
        await provider.close?.();
      }
      if (direct > 0) fail("the provider called fetch directly; call its API through a service registered with addService");
      const outside = (fixtures.http?.calls ?? []).slice(before).filter((call) => call.service === undefined);
      if (outside.length > 0) fail("the provider called HTTP outside a registered service; call its API through a service registered with addService");
    },
  },
];

const fixturesOf = async (options: SecretProviderContractOptions) => (typeof options.fixtures === "function" ? await options.fixtures() : options.fixtures);

/** Runs every check and resolves the failures, one `{ check, message }` each; an empty list means the provider passes. */
export async function checkSecretProvider(create: Create, options: SecretProviderContractOptions): Promise<{ check: string; message: string }[]> {
  const failures: { check: string; message: string }[] = [];
  for (const check of SECRET_PROVIDER_CHECKS) {
    try {
      await check.run(create, await fixturesOf(options));
    } catch (error) {
      failures.push({ check: check.name, message: (error as Error)?.message ?? String(error) });
    }
  }
  return failures;
}

/**
 * Registers one `bun:test` test per check of the secret provider contract: resolving a value and a key, a pinned
 * version, not found and access denied errors without values, aborting on the signal, `health()`, `close()` leaving
 * no timers, and HTTP only through registered services (unless the definition sets `transport: "sdk"`).
 */
export function runSecretProviderContract(create: Create, options: SecretProviderContractOptions): void {
  const label = options.name ?? "secret provider";
  for (const check of SECRET_PROVIDER_CHECKS) {
    test(`${label}: ${check.name}`, async () => {
      await check.run(create, await fixturesOf(options));
    });
  }
}
