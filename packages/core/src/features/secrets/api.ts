import type { SecretReference } from "../public.ts";

/** What a provider resolves a reference to: one text, with its version and how long it stays valid. */
export interface SecretResolution {
  /** The secret's value. */
  value: string;
  /** The version the provider resolved, like a vault's version number. */
  version?: string;
  /** How long the value may be cached, in milliseconds or as a duration like `5m`. */
  ttl?: number | string;
  /** When the value stops being valid, like the end of a lease. */
  expiresAt?: Date | number;
}

/** What `resolve` receives besides the reference. */
export interface SecretResolveContext {
  /** Aborted when the resolution times out; providers abort their requests with it. */
  signal: AbortSignal;
}

/** Resolves the references of its schemes, like `vault://` for a vault. */
export interface SecretProvider {
  /** The schemes the provider resolves, like `["vault"]`: lowercase letters, digits and dashes, never a URL scheme. */
  schemes: readonly string[];
  resolve(reference: SecretReference, context: SecretResolveContext): Promise<SecretResolution> | SecretResolution;
  /** Checks that the vault answers, for health checks (optional). */
  health?(): Promise<void> | void;
  /** Releases the provider's clients when the service stops (optional). */
  close?(): Promise<void> | void;
}

/** The API of the `secrets` native, for features that list it in `requires` or `enables`. */
export interface SecretsApi {
  /**
   * Registers a provider for its schemes during the calling feature's setup; a scheme registered twice, or one of the
   * reserved URL schemes, fails startup naming it.
   */
  provider(provider: SecretProvider): void;
  /** Whether a failing refresh fails readiness (`onRefreshError: "fail"`), and the paths of the values failing to refresh or expired. */
  status(): { critical: boolean; failing: string[] };
}
