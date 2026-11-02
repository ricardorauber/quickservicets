import { isSecretAccessError, isSecretNotFoundError, readBuiltInSecret, RESERVED_SECRET_SCHEMES, SECRET_SCHEME, secretEnvironment, selectSecretKey, type SecretReference } from "../public.ts";
import type { SecretProvider, SecretResolution } from "./api.ts";

/** The providers of a service, by scheme. */
export interface ProviderRegistry {
  add(provider: SecretProvider, owner: string): void;
  get(scheme: string): SecretProvider | undefined;
  has(scheme: string): boolean;
  /** Every registered provider, each once. */
  all(): SecretProvider[];
}

/** The problem with a provider's schemes (the rule, a reserved scheme or one taken), or undefined. */
export function schemeProblem(scheme: unknown, taken: ReadonlySet<string> = new Set()): string | undefined {
  if (typeof scheme !== "string" || !SECRET_SCHEME.test(scheme)) return `Invalid secret scheme ${JSON.stringify(scheme)}: it must match ${SECRET_SCHEME.source}`;
  if (RESERVED_SECRET_SCHEMES.includes(scheme)) return `The secret scheme ${scheme} is reserved for connection URLs`;
  if (taken.has(scheme)) return `The secret scheme ${scheme} is registered twice`;
  return undefined;
}

/** A registry checking each provider's schemes as it is added. */
export function providerRegistry(): ProviderRegistry {
  const byScheme = new Map<string, SecretProvider>();
  const providers: SecretProvider[] = [];
  return {
    add(provider, owner) {
      if (typeof provider !== "object" || provider === null || typeof provider.resolve !== "function" || !Array.isArray(provider.schemes) || provider.schemes.length === 0) {
        throw new Error(`${owner} registered an invalid secret provider: expected { schemes, resolve }`);
      }
      const taken = new Set(byScheme.keys());
      for (const scheme of provider.schemes) {
        const problem = schemeProblem(scheme, taken);
        if (problem) throw new Error(problem);
        taken.add(scheme);
      }
      for (const scheme of provider.schemes) byScheme.set(scheme, provider);
      providers.push(provider);
    },
    get: (scheme) => byScheme.get(scheme),
    has: (scheme) => byScheme.has(scheme),
    all: () => [...providers],
  };
}

/** The built-in `env://NAME` and `file://<path>` providers. */
export function builtInProviders(): SecretProvider[] {
  return [
    { schemes: ["env"], resolve: (reference) => ({ value: readBuiltInSecret(reference, secretEnvironment()) }) },
    { schemes: ["file"], resolve: (reference) => ({ value: readBuiltInSecret(reference) }) },
  ];
}

/** A failed resolution: the reason, never a value. */
export class ResolutionFailure extends Error {
  constructor(
    readonly reference: SecretReference,
    readonly reason: string,
  ) {
    super(`${reference.text}: ${reason}`);
    this.name = "ResolutionFailure";
  }
}

/** The reason of an error, without the reference text a provider or the core put first. */
export function reasonOf(reference: SecretReference, error: unknown): string {
  if (error instanceof ResolutionFailure) return error.reason;
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith(`${reference.text}: `) ? message.slice(reference.text.length + 2) : message;
}

/** How a reference is resolved: the time limit of each attempt and the retries after a failure. */
export interface ResolveSettings {
  timeout: number;
  retries: number;
  /** The pause before the first retry, doubled for each next one (default 250 ms). */
  backoff?: number;
}

/** What a resolution gives: the selected text and what the provider said about it. */
export interface ResolvedSecret {
  value: string;
  version?: string;
  ttl?: number | string;
  expiresAt?: Date | number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One call of the provider, aborted and failed after `timeout` milliseconds. */
async function attempt(provider: SecretProvider, reference: SecretReference, timeout: number): Promise<SecretResolution> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => provider.resolve(reference, { signal: controller.signal })),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new ResolutionFailure(reference, `timed out after ${timeout} ms`);
          controller.abort(error);
          reject(error);
        }, timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Whether an error must not be retried, like a secret that does not exist or an access refused. */
export type NoRetry = (error: unknown) => boolean;

/** A missing secret or version and a refused access do not change on a retry. */
export const permanent: NoRetry = (error) => isSecretNotFoundError(error) || isSecretAccessError(error);

/**
 * Resolves one reference through the provider of its scheme, each attempt within `timeout`, retrying failures up to
 * `retries` times with backoff; rejects with a `ResolutionFailure` whose reason holds no value.
 */
export async function resolveReference(registry: ProviderRegistry, reference: SecretReference, settings: ResolveSettings, noRetry: NoRetry = permanent): Promise<ResolvedSecret> {
  const provider = registry.get(reference.scheme);
  if (!provider) throw new ResolutionFailure(reference, `no provider for the scheme ${reference.scheme}`);
  let last: unknown;
  for (let index = 0; index <= settings.retries; index++) {
    if (index > 0) await sleep(Math.min(5000, (settings.backoff ?? 250) * 2 ** (index - 1)));
    try {
      const result = await attempt(provider, reference, settings.timeout);
      const value = selectSecretKey(reference, (result ?? {}) as never);
      return {
        value,
        ...(result.version !== undefined ? { version: String(result.version) } : {}),
        ...(result.ttl !== undefined ? { ttl: result.ttl } : {}),
        ...(result.expiresAt !== undefined ? { expiresAt: result.expiresAt } : {}),
      };
    } catch (error) {
      last = error;
      // What the value lacks (a key, valid JSON) does not change on a retry.
      if (error instanceof Error && !(error instanceof ResolutionFailure) && error.message.startsWith(`${reference.text}: `)) break;
      if (noRetry(error)) break;
    }
  }
  throw new ResolutionFailure(reference, reasonOf(reference, last));
}
