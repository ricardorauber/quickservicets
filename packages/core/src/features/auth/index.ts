import {
  boolean,
  cookieValue,
  defineFeature,
  hook,
  HttpError,
  list,
  object,
  provider,
  resolveOption,
  runAfterHooks,
  runtimeTargets,
  safeLog,
  string,
  taggedRoutes,
  type HandlerMiddleware,
  type Logger,
  type OptionFunction,
  type RequestUser,
  type ServiceRequest,
} from "../public.ts";
import { isAuthError, type AuthApi, type AuthFailure, type AuthProvider, type AuthResult, type Authenticated, type AuthorizeStep, type RequestAuth, type RevokeTarget, type UserStep } from "./api.ts";
import { buildRouteRules, parseRoleEntry, type RouteRule } from "./routes.ts";
import { markOperations } from "./openapi.ts";
import { isTestProvider } from "./test-provider.ts";

const options = object({
  required: boolean()
    .default(false)
    .perRequest()
    .describe(
      "Every route needs a signed-in user unless tagged @auth off; runtime routes registered with auth: false stay public. A function of the request, its user and tenant decides per request for the routes without an @auth tag, once the tenant is known.",
    ),
  scopes: list(string()).default([]).describe("The token scopes every route that needs a user requires, unless its @auth tag lists its own."),
  roles: list(string())
    .default([])
    .describe("The roles every route requires, as role or role:operation entries like the @roles tag (admin, admin:delete); empty by default."),
  providers: list(provider<AuthProvider>("AuthProvider", ["authenticate"]))
    .default([])
    .describe("Authentication providers of the project, tried before the providers features register; each has a name, the credentials it reads and authenticate."),
  beforeUser: hook<UserStep | RequestUser, undefined>().describe(
    "Runs after a provider's result with the user, req.auth and the request; it may return a changed user (like roles loaded from the database), and a throw answers with that error.",
  ),
  onAuthenticated: hook<Authenticated, undefined>().describe("Runs once a request is authenticated, with the user, req.auth and the request; a failure is logged."),
  onAuthFailed: hook<AuthFailure, undefined>().describe("Runs after credentials are refused with 401, with the provider, the reason and the request; a failure is logged."),
  beforeAuthorize: hook<AuthorizeStep | boolean, undefined>().describe(
    "Runs before the @auth and @roles checks of a route with the user, the route, its operation, roles and scopes and the request: true allows, false answers 403 Not allowed, undefined keeps the tag rules.",
  ),
});

/** The challenges of the running service's providers, for the answers of `requireUser` and `requireRole`. */
let currentProviders: readonly AuthProvider[] = [];

/** The 401 of a request that needs a user and has none, with the providers' challenges. */
export function authenticationRequired(providers: readonly AuthProvider[] = currentProviders): HttpError {
  const challenge = challengeHeader(providers, false);
  return new HttpError(401, "Authentication required", challenge ? { headers: { "www-authenticate": challenge } } : {});
}

/** The 403 of a user without a required role. */
export const notAllowed = () => new HttpError(403, "Not allowed");

/** The 403 of credentials without a required scope. */
export const insufficientScope = (scopes: readonly string[]) =>
  new HttpError(403, "Insufficient scope", { headers: { "www-authenticate": `Bearer error="insufficient_scope", scope="${scopes.join(" ")}"` } });

/** The signed-in user of an authenticated request, with the fields the `auth` native always sets. */
export type AuthenticatedUser = RequestUser & { id: string; roles: string[]; claims: Record<string, unknown> };

/** Returns the request's user, or throws the 401 `Authentication required` with the providers' challenges. */
export function requireUser(req: Pick<ServiceRequest, "user">): AuthenticatedUser {
  const user = req.user;
  if (!user) throw authenticationRequired();
  return { ...user, roles: user.roles ?? [], claims: user.claims ?? {} } as AuthenticatedUser;
}

/** Returns the request's user when it holds one of the roles; throws 401 without a user and 403 `Not allowed` without the role. */
export function requireRole(req: Pick<ServiceRequest, "user">, ...roles: string[]): AuthenticatedUser {
  const user = requireUser(req);
  if (!user.roles.some((role) => roles.includes(role))) throw notAllowed();
  return user;
}

/** The `req.auth` of each authenticated request. */
const authOf = new WeakMap<ServiceRequest, RequestAuth>();


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

/** Checks and registers a provider, after the ones registered before it. */
function registerProvider(state: { providers: AuthProvider[]; production: boolean }, provider: AuthProvider): void {
  if (typeof provider?.name !== "string" || provider.name === "" || typeof provider.authenticate !== "function") {
    throw new Error("auth provider() expects an AuthProvider with a name and an authenticate method");
  }
  if (isTestProvider(provider) && state.production) throw new Error("testAuth() cannot run in production");
  if (state.providers.some((registered) => registered.name === provider.name)) throw new Error(`Auth provider ${provider.name} is registered twice`);
  state.providers.push(provider);
}

/** The providers of each running setup, for the feature API. */
const statesOf = new WeakMap<object, { providers: AuthProvider[]; open: boolean; production: boolean; onRevoke: ((target: RevokeTarget) => unknown)[] }>();

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
        text: [
          "| Status | Code | Message |",
          "| --- | --- | --- |",
          "| 401 | `UNAUTHORIZED` | Invalid credentials |",
          "| 401 | `UNAUTHORIZED` | Authentication required |",
          "| 403 | `FORBIDDEN` | Not allowed |",
          "| 403 | `FORBIDDEN` | Insufficient scope |",
          "| 401 | `INVALID_CREDENTIALS` | Invalid credentials (`invalidCredentials()`, for providers' sign-in routes) |",
          "| 429 | `RATE_LIMITED` | Too many attempts; try again later (`loginGuard`) |",
        ].join("\n"),
      },
      {
        title: "Override files and eject",
        text: "The native contributes no entities, endpoints, hooks, jobs or folders, so there are no files to override. `quickservicets eject auth` copies it into `features/auth/`, a project feature that replaces it and keeps its behavior.",
      },
    ],
  },
  options,
  // The document marks the routes these natives add, so their openapi functions run first.
  after: ["health", "history", "realtime"],
  request: { auth: (req) => authOf.get(req) },
  openapi(doc, { models, options, routes, config }) {
    // A required function may need a user on any route without @auth, so the document marks them all.
    const health = config.features.find((feature) => feature.key === "health")?.options as { live?: string; ready?: string } | undefined;
    const publicPaths = health ? [health.live, health.ready].filter((path): path is string => typeof path === "string") : [];
    return markOperations(doc, { routes, models, options: { required: typeof options.required === "function" ? true : (options.required as boolean), scopes: options.scopes, roles: options.roles }, publicPaths });
  },
  tags: {
    auth: {
      on: ["entity", "endpoint"],
      options: ["scopes"],
      description:
        "`@auth` requires a signed-in user on every route of an entity or on one endpoint, `@auth scopes=posts:write` also requires token scopes, and `@auth off` keeps the target public when `required` is true.",
      example: "/** @auth */\nexport type Post = { title: string };",
    },
    roles: {
      on: ["entity", "endpoint"],
      options: ["roles"],
      shorthand: "roles",
      description:
        "`@roles admin` requires one of the roles on every route of the target; on entities, `@roles admin:delete` restricts one operation (list, read, create, update, replace, delete) or a group (view, write).",
      example: "/** @roles editor:write,admin:delete */\nexport type Post = { title: string };",
      check: (tag, _options, target) => {
        for (const entry of (tag.roles as string[] | undefined) ?? []) {
          const parsed = parseRoleEntry(entry, target === "entity");
          if (typeof parsed === "string") return parsed;
        }
        return undefined;
      },
    },
  },
  setup(ctx) {
    const state = { providers: [] as AuthProvider[], open: true, production: ctx.config.production, onRevoke: [] as ((target: RevokeTarget) => unknown)[] };
    statesOf.set(ctx.options, state);
    const { providers } = state;
    currentProviders = providers;
    // The project's providers come before the ones features register.
    for (const project of ctx.options.providers as AuthProvider[]) registerProvider(state, project);
    const { beforeUser, onAuthenticated, onAuthFailed, beforeAuthorize } = ctx.options;
    const requiredFunction = typeof ctx.options.required === "function" ? (ctx.options.required as OptionFunction<boolean>) : undefined;
    let index: CredentialIndex | undefined;
    const ruleOptions = { required: requiredFunction ? undefined : (ctx.options.required as boolean), scopes: ctx.options.scopes, roles: ctx.options.roles };
    /** The routes whose rule differs from the default, decided once every feature registered its routes. */
    let rules: Map<string, RouteRule> | undefined;
    const rulesOf = () => (rules ??= buildRouteRules({ tagged: taggedRoutes(), runtime: runtimeTargets(), models: ctx.models }, ruleOptions));
    const defaultRule: RouteRule | undefined = ctx.options.required === true ? { user: true, scopes: ctx.options.scopes, tagged: false } : undefined;
    ctx.app.onStart(() => {
      state.open = false;
      index = credentialIndex(providers);
      rulesOf();
    });
    const refused = async (req: ServiceRequest, provider: string | undefined, reason: string) => {
      logFailure(ctx.logger, req, provider, reason);
      if (onAuthFailed.length > 0) await runAfterHooks(onAuthFailed, { provider, reason, req }, undefined);
    };
    /** Answers 401, 403 or nothing for a request against its route's rule. */
    const authorize = async (req: ServiceRequest, rule: RouteRule) => {
      const user = req.user;
      if (beforeAuthorize.length > 0) {
        const step: AuthorizeStep = { user, route: req.route, operation: rule.operation, roles: rule.roles ? [...rule.roles] : [], scopes: [...rule.scopes], req };
        for (const fn of beforeAuthorize) {
          const decision = await fn(step, undefined);
          if (decision === true) return;
          if (decision === false) throw notAllowed();
        }
      }
      if (rule.user && !user) {
        await refused(req, undefined, "missing credentials");
        throw authenticationRequired(providers);
      }
      if (rule.roles && !(user?.roles ?? []).some((role) => rule.roles!.has(role))) throw notAllowed();
      if (rule.scopes.length > 0) {
        const granted = authOf.get(req)?.scopes ?? [];
        if (!rule.scopes.every((scope) => granted.includes(scope))) throw insufficientScope(rule.scopes);
      }
    };
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
            if (isAuthError(error)) {
              await refused(req, provider.name, error.reason);
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
            if (beforeUser.length > 0) {
              let user = req.user!;
              for (const fn of beforeUser) {
                const changed = (await fn({ user, auth: authOf.get(req)!, req }, undefined)) as unknown;
                if (changed && typeof changed === "object") user = ("user" in changed && "req" in changed ? (changed as UserStep).user : changed) as RequestUser;
              }
              req.user = { ...user, roles: user.roles ?? [], claims: user.claims ?? {} };
            }
            if (onAuthenticated.length > 0) await runAfterHooks(onAuthenticated, { user: req.user!, auth: authOf.get(req)!, req }, undefined);
            break;
          }
        }
        const routes = rulesOf();
        // Without tagged routes and with required false, a request does no lookup at all.
        const rule = routes.size === 0 ? defaultRule : (routes.get(`${req.method} ${req.route}`) ?? defaultRule);
        if (rule) await authorize(req, rule);
        else if (!requiredFunction && beforeAuthorize.length > 0) await authorize(req, { user: false, scopes: [], tagged: false });
        return next();
      },
    };
    ctx.app.use(authenticate);
    if (requiredFunction) {
      // A required function may read the tenant, which tenancy resolves at 200; it decides the routes without @auth.
      const decide: HandlerMiddleware = {
        stage: "handler",
        order: 250,
        async run(req, _res, next) {
          if (!rulesOf().has(`${req.method} ${req.route}`)) {
            const needs = (await resolveOption(requiredFunction, { req })) === true;
            await authorize(req, needs ? { user: true, scopes: ctx.options.scopes, tagged: false } : { user: false, scopes: [], tagged: false });
          }
          return next();
        },
      };
      ctx.app.use(decide);
    }
  },
  api: (ctx): AuthApi => {
    const state = statesOf.get(ctx.options)!;
    return {
      provider(provider) {
        if (!state.open) throw new Error("auth provider() is only available during setup");
        registerProvider(state, provider);
      },
      addHook: ctx.addHook as AuthApi["addHook"],
      async revoke(target) {
        if (typeof target !== "object" || target === null || (typeof (target as { sessionId?: unknown }).sessionId !== "string" && typeof (target as { userId?: unknown }).userId !== "string")) {
          throw new Error("auth revoke() expects { sessionId } or { userId }");
        }
        const failed = (source: Record<string, unknown>, error: unknown) =>
          safeLog(ctx.logger, "error", { timestamp: new Date().toISOString(), message: "auth.revoke.failed", ...source, error: { message: (error as Error)?.message ?? String(error) } });
        const events = ctx.config.features.some((feature) => feature.key === "events");
        for (const provider of state.providers) {
          if (typeof provider.revoke !== "function") continue;
          try {
            await provider.revoke(target);
          } catch (error) {
            failed({ provider: provider.name }, error);
            continue;
          }
          if (events) {
            try {
              await ctx.events.emit("auth.session.revoked", { ...target, provider: provider.name });
            } catch (error) {
              failed({ provider: provider.name, event: "auth.session.revoked" }, error);
            }
          }
        }
        for (const fn of state.onRevoke) {
          try {
            await fn(target);
          } catch (error) {
            failed({ callback: "onRevoke" }, error);
          }
        }
      },
      onRevoke(fn) {
        if (!state.open) throw new Error("auth onRevoke() is only available during setup");
        if (typeof fn !== "function") throw new Error("auth onRevoke() expects a function");
        state.onRevoke.push(fn);
      },
    };
  },
});

export default authFeature;
export { authFeature };
export { AuthError, isAuthError } from "./api.ts";
export type { AuthApi, AuthCredentials, AuthFailure, AuthMethod, AuthProvider, AuthResult, AuthResultUser, Authenticated, AuthorizeStep, RequestAuth, RevokeTarget, SessionRevokedEvent, UserStep } from "./api.ts";
export { isTestProvider, parseTestUser, testAuth } from "./test-provider.ts";
export { dummyPasswordCheck, identifierHash, invalidCredentials, loginGuard, memoryThrottleStore, repositoryThrottleStore, ThrottleConflictError, tooManyAttempts } from "./kit.ts";
export type { LoginCheck, LoginGuard, LoginGuardOptions, LoginThrottleRecord, LoginThrottleStore } from "./kit.ts";
export { sessionStore, tokenHashOf } from "./sessions.ts";
export type { SessionStore, SessionStoreOptions, StoredSession } from "./sessions.ts";
export { addAuthScheme, hasSecurityScheme, markOperations, NO_AUTH_SCHEME_WARNING } from "./openapi.ts";
export type { OperationAuth } from "./openapi.ts";
export { buildRouteRules, parseRoleEntry, ROLE_GROUPS, ROLE_OPERATIONS, ruleOf } from "./routes.ts";
export type { RoleEntry, RouteRule, RuleOptions } from "./routes.ts";
export type { TestAuthOptions } from "./test-provider.ts";
