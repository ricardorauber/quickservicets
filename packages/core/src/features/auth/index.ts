import { defineFeature, HttpError, safeLog, type HandlerMiddleware, type Logger, type ServiceRequest } from "../public.ts";
import { AuthError, type AuthApi, type AuthProvider, type AuthResult, type RequestAuth } from "./api.ts";
import { isTestProvider } from "./test-provider.ts";

/** The `req.auth` of each authenticated request. */
const authOf = new WeakMap<ServiceRequest, RequestAuth>();

/** The value of one cookie of a `Cookie` header, or undefined without it. */
export function cookieValue(header: string, name: string): string | undefined {
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

/** The credential names of the registered providers, each with the providers that read it. */
interface CredentialIndex {
  headers: [string, AuthProvider[]][];
  cookies: [string, AuthProvider[]][];
  query: [string, AuthProvider[]][];
}

function credentialIndex(providers: readonly AuthProvider[]): CredentialIndex {
  const group = (kind: "headers" | "cookies" | "query", normalize: (name: string) => string) => {
    const owners = new Map<string, AuthProvider[]>();
    for (const provider of providers) {
      for (const name of provider.credentials?.[kind] ?? []) {
        const key = normalize(name);
        const list = owners.get(key) ?? [];
        if (!list.includes(provider)) list.push(provider);
        owners.set(key, list);
      }
    }
    return [...owners];
  };
  return { headers: group("headers", (name) => name.toLowerCase()), cookies: group("cookies", (name) => name), query: group("query", (name) => name) };
}

/** The providers owning a credential the request carries, in registration order; empty after one lookup per name. */
function presentProviders(req: ServiceRequest, index: CredentialIndex, order: readonly AuthProvider[]): AuthProvider[] {
  let found: Set<AuthProvider> | undefined;
  const add = (owners: AuthProvider[]) => {
    found ??= new Set();
    for (const owner of owners) found.add(owner);
  };
  for (const [name, owners] of index.headers) if (req.headers.has(name)) add(owners);
  if (index.cookies.length > 0) {
    const cookie = req.headers.get("cookie");
    if (cookie !== null) for (const [name, owners] of index.cookies) if (cookieValue(cookie, name) !== undefined) add(owners);
  }
  for (const [name, owners] of index.query) if (req.query.has(name)) add(owners);
  return found === undefined ? [] : order.filter((provider) => found!.has(provider));
}

/** The `WWW-Authenticate` value of the providers' challenges; bearer challenges say the token was invalid when asked. */
export function challengeHeader(providers: readonly AuthProvider[], invalidToken: boolean): string | undefined {
  const challenges = providers
    .map((provider) => provider.challenge)
    .filter((challenge): challenge is string => typeof challenge === "string" && challenge !== "")
    .map((challenge) => (invalidToken && /^bearer(\s|$)/i.test(challenge) ? `${challenge}, error="invalid_token"` : challenge));
  return challenges.length > 0 ? challenges.join(", ") : undefined;
}

/** Sets `req.user`, `req.auth` and, with a tenant, `req.tenant` from a provider's result. */
function applyResult(req: ServiceRequest, provider: AuthProvider, result: AuthResult): void {
  const { user } = result;
  req.user = {
    id: String(user.id),
    roles: Array.isArray(user.roles) ? user.roles.map(String) : [],
    ...(user.email !== undefined ? { email: user.email } : {}),
    ...(user.name !== undefined ? { name: user.name } : {}),
    claims: user.claims ?? {},
  };
  const auth: RequestAuth = { provider: provider.name, method: result.method, sessionId: result.sessionId, expiresAt: result.expiresAt, scopes: result.scopes };
  authOf.set(req, auth);
  // The property may have been read (and kept as undefined) before authentication ran.
  Object.defineProperty(req, "auth", { value: auth, configurable: true, enumerable: false, writable: true });
  if (result.tenant !== undefined) req.tenant = { id: String(result.tenant.id) } as ServiceRequest["tenant"];
}

/** Logs a refused request without its credentials. */
function logFailure(logger: Logger, req: ServiceRequest, provider: string | undefined, reason: string): void {
  safeLog(logger, "info", { timestamp: new Date().toISOString(), message: "auth.failed", ...(provider !== undefined ? { provider } : {}), reason, ip: req.ip });
}

/** The providers of each running setup, for the feature API. */
const statesOf = new WeakMap<object, { providers: AuthProvider[]; open: boolean; production: boolean }>();

/**
 * The `auth` native: one contract for every authentication provider. Providers registered by features are tried for
 * requests that carry their credentials, and the first result fills `req.user`, `req.auth` and optionally
 * `req.tenant`. Off unless `auth: {}` (or `QS_AUTH_ENABLED=true`) is set, or a feature enables it.
 */
const authFeature = defineFeature({
  key: "auth",
  docs: {
    summary: "One authentication contract for every provider: the first provider that accepts a request's credentials fills req.user, req.auth and optionally req.tenant.",
    sections: [
      {
        title: "Error codes",
        text: ["| Status | Code | Message |", "| --- | --- | --- |", "| 401 | `UNAUTHORIZED` | Invalid credentials |"].join("\n"),
      },
    ],
  },
  request: { auth: (req) => authOf.get(req) },
  setup(ctx) {
    const state = { providers: [] as AuthProvider[], open: true, production: ctx.config.production };
    statesOf.set(ctx.options, state);
    const { providers } = state;
    let index: CredentialIndex | undefined;
    ctx.app.onStart(() => {
      state.open = false;
      index = credentialIndex(providers);
    });
    const authenticate: HandlerMiddleware = {
      stage: "handler",
      // Before CSRF (150), tenancy (200) and the security limits keyed by user (1000).
      order: 100,
      async run(req, _res, next) {
        index ??= credentialIndex(providers);
        const present = presentProviders(req, index, providers);
        for (const provider of present) {
          let result: AuthResult | null;
          try {
            result = await provider.authenticate(req);
          } catch (error) {
            if (error instanceof AuthError) {
              logFailure(ctx.logger, req, provider.name, error.reason);
              const challenge = challengeHeader(providers, true);
              throw new HttpError(401, "Invalid credentials", challenge ? { headers: { "www-authenticate": challenge } } : {});
            }
            safeLog(ctx.logger, "error", {
              timestamp: new Date().toISOString(),
              message: "auth.provider.failed",
              provider: provider.name,
              error: { message: (error as Error)?.message ?? String(error), ...(error instanceof Error ? { stack: error.stack } : {}) },
            });
            throw error;
          }
          if (result) {
            applyResult(req, provider, result);
            break;
          }
        }
        return next();
      },
    };
    ctx.app.use(authenticate);
  },
  api: (ctx): AuthApi => {
    const state = statesOf.get(ctx.options)!;
    return {
      provider(provider) {
        if (!state.open) throw new Error("auth provider() is only available during setup");
        if (typeof provider?.name !== "string" || provider.name === "" || typeof provider.authenticate !== "function") {
          throw new Error("auth provider() expects an AuthProvider with a name and an authenticate method");
        }
        if (isTestProvider(provider) && state.production) throw new Error("testAuth() cannot run in production");
        if (state.providers.some((registered) => registered.name === provider.name)) throw new Error(`Auth provider ${provider.name} is registered twice`);
        state.providers.push(provider);
      },
    };
  },
});

export default authFeature;
export { authFeature };
export { AuthError } from "./api.ts";
export type { AuthApi, AuthCredentials, AuthMethod, AuthProvider, AuthResult, AuthResultUser, RequestAuth, RevokeTarget } from "./api.ts";
export { isTestProvider, parseTestUser, testAuth } from "./test-provider.ts";
export type { TestAuthOptions } from "./test-provider.ts";
