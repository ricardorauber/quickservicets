import type { CrudOperation, FeatureHook, RequestUser, ServiceRequest } from "../public.ts";

/** How a request proved who it is. */
export type AuthMethod = "bearer" | "cookie" | "apiKey" | "certificate" | "test";

/** The user an authentication provider found, as it returns it. */
export interface AuthResultUser {
  id: string;
  roles?: string[];
  email?: string;
  name?: string;
  /** Any other claims of the credentials, like the token's payload. */
  claims?: Record<string, unknown>;
}

/** What an authentication provider returns for credentials it accepts. */
export interface AuthResult {
  user: AuthResultUser;
  /** The tenant the credentials belong to; the `tenancy` native then refuses a request for another tenant. */
  tenant?: { id: string };
  method: AuthMethod;
  /** The session the credentials belong to, so it can be revoked. */
  sessionId?: string;
  /** When the credentials expire. */
  expiresAt?: Date;
  /** The scopes the credentials grant, like a token's `scope` claim. */
  scopes?: string[];
}

/** Where a request carries the credentials a provider reads. */
export interface AuthCredentials {
  /** Header names, like `authorization`. */
  headers?: readonly string[];
  /** Cookie names, like `session`. */
  cookies?: readonly string[];
  /** Query parameter names, like `access_token`. */
  query?: readonly string[];
}

/** What a session revocation names: one session, or every session of a user. */
export type RevokeTarget = { sessionId: string } | { userId: string };

/**
 * One way of signing users in: the `auth` native calls `authenticate` for requests that carry one of its credentials,
 * in registration order, until a provider returns a result.
 */
export interface AuthProvider {
  /** A unique name, like `keycloak`. */
  name: string;
  /** The header, cookie and query parameter names the provider reads. */
  credentials: AuthCredentials;
  /**
   * Returns the user of the request's credentials, null when they are not this provider's, or throws an `AuthError`
   * for expired, malformed or revoked credentials.
   */
  authenticate(req: ServiceRequest): AuthResult | null | Promise<AuthResult | null>;
  /** The `WWW-Authenticate` value the provider offers, like `Bearer realm="api"`. */
  challenge?: string;
  /** Revokes a session, or every session of a user. */
  revoke?(target: RevokeTarget): void | Promise<void>;
}

/** What `req.auth` holds for an authenticated request. */
export interface RequestAuth {
  /** The name of the provider that accepted the credentials. */
  provider: string;
  method: AuthMethod;
  sessionId: string | undefined;
  expiresAt: Date | undefined;
  scopes: string[] | undefined;
}

/**
 * Thrown by a provider for credentials that are its own but cannot be accepted (expired, malformed or revoked): the
 * request answers 401 `Invalid credentials`.
 */
export class AuthError extends Error {
  /** Why the credentials were refused, as the log entry says; never sent to the client. */
  readonly reason: string;

  constructor(reason = "invalid") {
    super(reason);
    this.name = "AuthError";
    this.reason = reason;
    Object.defineProperty(this, AUTH_ERROR, { value: true });
  }
}

/** Marks `AuthError`s, shared by every copy of the class (an ejected native's included). */
const AUTH_ERROR = Symbol.for("quickservicets.auth.error");

/** Whether a value is an `AuthError`, from this copy of the class or another one. */
export function isAuthError(error: unknown): error is AuthError {
  return error instanceof AuthError || (typeof error === "object" && error !== null && (error as Record<symbol, unknown>)[AUTH_ERROR] === true);
}

/** The feature API of `auth`, reached with `ctx.feature("auth")` from a feature that lists it in `requires`, `after` or `enables`. */
export interface AuthApi {
  /** Registers an authentication provider; providers are tried in registration order. Only available during setup. */
  provider(provider: AuthProvider): void;
  /**
   * Revokes one session or every session of a user: calls `revoke` of every provider that has it (a failure is logged
   * as `auth.revoke.failed` and the others still run), emits `auth.session.revoked` per provider while `events` is on,
   * and runs the `onRevoke` callbacks.
   */
  revoke(target: RevokeTarget): Promise<void>;
  /** Runs `fn` after every revocation, like closing the sockets of a revoked session. Only available during setup. */
  onRevoke(fn: (target: RevokeTarget) => unknown): void;
  /** Appends a hook (`beforeUser`, `onAuthenticated`, `onAuthFailed` or `beforeAuthorize`) after the config's. */
  addHook<K extends keyof AuthHooks>(name: K, fn: AuthHooks[K]): void;
}

/** What `beforeUser` hooks receive: they may return a changed user. */
export interface UserStep {
  user: RequestUser;
  auth: RequestAuth;
  req: ServiceRequest;
}

/** What `onAuthenticated` hooks receive. */
export interface Authenticated {
  user: RequestUser;
  auth: RequestAuth;
  req: ServiceRequest;
}

/** What `onAuthFailed` hooks receive for each 401. */
export interface AuthFailure {
  /** The provider that refused the credentials; undefined when the request had none. */
  provider: string | undefined;
  reason: string;
  req: ServiceRequest;
}

/** What `beforeAuthorize` hooks receive: true allows, false answers 403, undefined keeps the tag rules. */
export interface AuthorizeStep {
  user: RequestUser | undefined;
  /** The route's path pattern, like `/posts/[id]`. */
  route: string;
  /** The entity operation of the route, if any. */
  operation: CrudOperation | undefined;
  /** The roles of which the route requires one (empty when roles do not restrict it). */
  roles: string[];
  scopes: string[];
  req: ServiceRequest;
}

/** The hooks of the `auth` native, by name. */
export interface AuthHooks {
  beforeUser: FeatureHook<UserStep | RequestUser, undefined>;
  onAuthenticated: FeatureHook<Authenticated, undefined>;
  onAuthFailed: FeatureHook<AuthFailure, undefined>;
  beforeAuthorize: FeatureHook<AuthorizeStep | boolean, undefined>;
}

/** The payload of the `auth.session.revoked` event. */
export interface SessionRevokedEvent {
  userId?: string;
  sessionId?: string;
  /** The provider that revoked it. */
  provider: string;
}
