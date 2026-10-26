import {
  defineFeature,
  duration,
  entityRoutePath,
  afterCommit,
  hook,
  HttpError,
  integer,
  observeWrites,
  parseDuration,
  provider,
  runAfterHooks,
  list,
  object,
  oneOf,
  record,
  safeLog,
  setContextFlags,
  string,
  suggestion,
  taggedRoutes,
  toggle,
  type EntityModel,
  type FeatureHook,
  type HandlerMiddleware,
  type Logger,
  type OpenApiDoc,
  type ParsedTags,
  type ServiceRequest,
} from "../public.ts";
import type { FlagContext, FlagProvider, FlagsApi, RequestFlagEvaluator } from "./api.ts";
import { evaluateRule, FLAG_NAME, FLAG_NAME_MESSAGE, idOf, type FlagReason, type FlagResult, type FlagRule, type FlagSubject } from "./evaluate.ts";
import { flagCommands } from "./commands.ts";
import { featureFlagEntity, loadFlagRows, ruleOfRow } from "./store.ts";

const options = object({
  source: oneOf(["config", "database"]).default("config").describe("Where the flags live: the rules of the config, or the FeatureFlag table with the config rules as defaults."),
  rules: record(
    toggle({
      users: list(string()).optional().describe("The user ids the flag is on for."),
      tenants: list(string()).optional().describe("The tenant ids the flag is on for."),
      percentage: integer().min(0).max(100).optional().describe("The share of users (or tenants without a user) the flag is on for, stable across processes."),
      description: string().optional().describe("What the flag turns on, for people reading the config."),
    })
      .perRequest()
      .describe("One flag: true or false for everyone, who it is on for, or a function of the request, its user and tenant returning a boolean synchronously."),
  )
    .keys(FLAG_NAME, FLAG_NAME_MESSAGE)
    .describe("The flags by name: lowercase letters, digits, _ and -."),
  refresh: duration().default("30s").describe("How often each worker reloads the flags of the database source."),
  gate: string()
    .optional()
    .describe("A flag every route needs: while it is off for a caller, every route answers 404; set per endpoint or entity with @flag."),
  onEvaluate: hook<FlagEvaluation, undefined>().describe("Runs after each new evaluation with the name, the value, the reason, the user, the tenant and the request; it observes and cannot change the value."),
  provider: provider<FlagProvider>("FlagProvider", ["isOn", "all"])
    .optional()
    .describe("Replaces the evaluation of both sources: isOn(name, ctx) answers synchronously, all(ctx) lists every flag, and optional start() and stop() run with the server."),
});

/** The gate of one route: its `@flag` (an endpoint's over its entity's), `@flag off` for none, else the global gate. */
export function gateOf(tags: ParsedTags | undefined, globalGate: string | undefined): string | undefined {
  const tag = tags?.flag;
  if (!tag) return globalGate;
  if (!tag.on) return undefined;
  return (tag.options.gate as string | undefined) ?? globalGate;
}

/** The entity whose collection path is the longest prefix of a route, for the routes other natives add for it. */
export function entityOfRoute(models: readonly EntityModel[], route: string): EntityModel | undefined {
  let found: EntityModel | undefined;
  for (const model of models) {
    if (model.internal || model.system || model.link) continue;
    const collection = entityRoutePath(model);
    if ((route === collection || route.startsWith(`${collection}/`)) && (!found || collection.length > entityRoutePath(found).length)) found = model;
  }
  return found;
}

/**
 * The gates of the app's routes, by method and route: generated routes and endpoints from their tags, the runtime
 * routes of other natives from the entity whose path they extend, anything else from the global gate. Each route is
 * looked up once, on its first request.
 */
export function routeGates(models: readonly EntityModel[], globalGate: string | undefined) {
  let tagged: Map<string, ParsedTags | undefined> | undefined;
  const cache = new Map<string, string | null>();
  return (method: string, route: string): string | undefined => {
    const key = `${method} ${route}`;
    let gate = cache.get(key);
    if (gate === undefined) {
      tagged ??= new Map(taggedRoutes().map((entry) => [`${entry.method} ${entry.path}`, entry.tags]));
      const tags = tagged.has(key) ? tagged.get(key) : entityOfRoute(models, route)?.tags;
      gate = gateOf(tags, globalGate) ?? null;
      cache.set(key, gate);
    }
    return gate ?? undefined;
  };
}

/** A rule computed per request: a function of the request, its user and tenant, and the flag's name. */
export type FlagRuleFunction = (ctx: { req: ServiceRequest | undefined; user: unknown; tenant: unknown; name: string }) => unknown;

/** The rules of the running service, by name. */
export type FlagRules = ReadonlyMap<string, FlagRule | FlagRuleFunction>;

/** What `onEvaluate` hooks observe after each new evaluation. */
export interface FlagEvaluation {
  name: string;
  on: boolean;
  reason: FlagReason;
  user: unknown;
  tenant: unknown;
  req: ServiceRequest | undefined;
}

/** Who a flag is evaluated for, with the request when there is one. */
interface EvaluationTarget extends FlagSubject {
  user?: unknown;
  tenant?: unknown;
  req?: ServiceRequest;
}

/**
 * Evaluates flags: through the provider when one is set, else against the rules (functions called synchronously),
 * warning once per process about each unknown name; runs the `onEvaluate` hooks after each evaluation.
 */
export function flagEvaluator(rules: () => FlagRules, logger: Logger, settings: { provider?: () => FlagProvider | undefined; onEvaluate?: readonly FeatureHook<FlagEvaluation, undefined>[] } = {}) {
  const warned = new Set<string>();
  const decide = (name: string, target: EvaluationTarget): FlagResult => {
    const provider = settings.provider?.();
    if (provider) return { on: provider.isOn(name, { user: target.user, tenant: target.tenant, req: target.req }) === true, reason: "provider" };
    const rule = rules().get(name);
    if (!rule) {
      if (!warned.has(name)) {
        warned.add(name);
        safeLog(logger, "warn", { timestamp: new Date().toISOString(), message: "flags.unknown", flag: name });
      }
      return { on: false, reason: "unknown" };
    }
    if (typeof rule === "function") {
      const value = rule({ req: target.req, user: target.user, tenant: target.tenant, name });
      if (typeof value !== "boolean") throw new Error(`Invalid flags.rules.${name}: expected a boolean returned synchronously`);
      return { on: value, reason: "function" };
    }
    return evaluateRule(name, rule, target);
  };
  const evaluate = (name: string, target: EvaluationTarget): FlagResult => {
    const result = decide(name, target);
    const hooks = settings.onEvaluate ?? [];
    if (hooks.length > 0) void runAfterHooks(hooks, { name, on: result.on, reason: result.reason, user: target.user, tenant: target.tenant, req: target.req }, undefined);
    return result;
  };
  /** The names `all()` lists: the provider's, or the rules'. */
  const all = (target: EvaluationTarget, on: (name: string) => boolean = (name) => evaluate(name, target).on): Record<string, boolean> => {
    const provider = settings.provider?.();
    if (provider) return { ...provider.all({ user: target.user, tenant: target.tenant, req: target.req }) };
    return Object.fromEntries([...rules().keys()].map((name) => [name, on(name)]));
  };
  return { evaluate, all };
}

/** Who a call outside a request reads flags for. */
const subjectOf = (context: FlagContext = {}, req?: ServiceRequest): EvaluationTarget => {
  const userId = idOf(context.user);
  const tenantId = idOf(context.tenant);
  return {
    ...(userId !== undefined ? { userId } : {}),
    ...(tenantId !== undefined ? { tenantId } : {}),
    ...(context.user !== undefined ? { user: context.user } : {}),
    ...(context.tenant !== undefined ? { tenant: context.tenant } : {}),
    ...(req ? { req } : {}),
  };
};

/** The evaluator of one request: synchronous, reading the request's user and tenant when asked, each name evaluated once. */
export function requestFlags(req: ServiceRequest, evaluator: ReturnType<typeof flagEvaluator>): RequestFlagEvaluator {
  const memo = new Map<string, boolean>();
  const target = () => subjectOf({ user: req.user, tenant: req.tenant }, req);
  const on = (name: string) => {
    let value = memo.get(name);
    if (value === undefined) {
      value = evaluator.evaluate(name, target()).on;
      memo.set(name, value);
    }
    return value;
  };
  return {
    on,
    off: (name) => !on(name),
    all: () => evaluator.all(target(), on),
  };
}

/** The rules of the resolved options, `true`, `false` and functions included. */
export function configRules(rules: Readonly<Record<string, unknown>>): FlagRules {
  return new Map(Object.entries(rules).map(([name, rule]) => [name, rule as FlagRule | FlagRuleFunction]));
}

/**
 * The `flags` native: feature flags turned on per user, per tenant or for a percentage of users by rules in the config,
 * read as `req.flags.on("checkout-v2")` in endpoints and hooks. Off unless `flags: {}` (or `QS_FLAGS_ENABLED=true`).
 */
const flagsFeature = defineFeature({
  key: "flags",
  docs: { summary: "Feature flags turned on per user, per tenant or for a percentage of users, read synchronously in any endpoint or hook." },
  options,
  // The table of the database source; nothing with the config source.
  entities: ({ models, options }) => {
    if (options.source !== "database") return [];
    // A project `entities/FeatureFlag.ts` replaces the table, keeping every field the native reads.
    const project = models.find((model) => model.key === "FeatureFlag" && !model.feature);
    if (project) assertFlagFields(project);
    return [featureFlagEntity()];
  },
  commands: flagCommands,
  tags: {
    flag: {
      on: ["entity", "endpoint"],
      options: ["gate"],
      shorthand: "gate",
      description:
        "`@flag checkout-v2` hides an endpoint, or every route of an entity, behind a flag: while it is off for the caller they answer 404; `@flag off` removes the global gate.",
      example: "/** @flag checkout-v2 */\nexport default () => ({ ok: true });",
      check: (tag, options) => {
        const name = tag.gate as string | undefined;
        if (name === undefined || options.source === "database") return undefined;
        const known = Object.keys((options.rules as Record<string, unknown> | undefined) ?? {});
        return known.includes(name) ? undefined : `unknown flag ${name}${suggestion(name, known)}`;
      },
    },
  },
  // `on` and `off` accept the names of the config's rules, or any name with the database source.
  build(ctx) {
    const names = Object.keys(ctx.options.rules as Record<string, unknown>);
    const flagName = ctx.options.source === "database" || names.length === 0 ? "string" : names.map((name) => JSON.stringify(name)).join(" | ");
    return ctx.write(
      "types.ts",
      [
        "// Generated by quickservice build. Do not edit.",
        'import type { ContextFlagEvaluator, RequestFlagEvaluator } from "@quickservice/core";',
        "",
        "/** The flags `req.flags` knows. */",
        `export type FlagName = ${flagName};`,
        "",
        'declare module "@quickservice/core" {',
        "  interface RequestFlags extends RequestFlagEvaluator<FlagName> {}",
        "  interface JobContext {",
        "    /** The flags, read for the user and tenant given in each call. */",
        "    flags: ContextFlagEvaluator<FlagName>;",
        "  }",
        "  interface QueueContext {",
        "    /** The flags, read for the user and tenant given in each call. */",
        "    flags: ContextFlagEvaluator<FlagName>;",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  },
  setup(ctx) {
    // The provider of the config, or of the one feature that sets it during setup.
    const slot: ProviderSlot = { ...(ctx.options.provider ? { current: ctx.options.provider as FlagProvider, owner: "flags.provider" } : {}) };
    providers.set(ctx.options, slot);
    ctx.app.onStart(async () => {
      await slot.current?.start?.();
    });
    ctx.app.onStop(async () => {
      await slot.current?.stop?.();
    });
    const config = configRules(ctx.options.rules as Record<string, unknown>);
    let rules: FlagRules = config;
    if (ctx.options.source === "database") {
      const model = ctx.models.find((candidate) => candidate.key === "FeatureFlag");
      if (!model) throw new Error('flags.source is "database" but the FeatureFlag entity is missing; set flags: { source: "database" } in quickservice.config.ts, then run quickservice migration add');
      const adapter = ctx.config.database;
      /** The rows, applied over the config's rules: a row replaces the rule of its name. */
      let rows = new Map<string, FlagRule>();
      const apply = () => {
        rules = new Map([...config, ...rows]);
      };
      const reload = async () => {
        rows = await loadFlagRows(adapter, model);
        apply();
      };
      let timer: ReturnType<typeof setInterval> | undefined;
      ctx.app.onStart(async () => {
        await reload();
        timer = setInterval(() => {
          reload().catch((error: unknown) =>
            safeLog(ctx.logger, "error", { timestamp: new Date().toISOString(), message: "flags.refresh.failed", error: { message: (error as Error)?.message ?? String(error) } }),
          );
        }, parseDuration(ctx.options.refresh) ?? 30_000);
      });
      // Writes through this process's repositories apply once they commit; other processes see them at the next refresh.
      const stopObserving = observeWrites({
        entities: [model.key],
        transactional: true,
        write(change) {
          const name = String((change.after ?? change.before)?.name ?? "");
          if (change.after && !FLAG_NAME.test(name)) throw new HttpError(400, `Invalid flags.rules.${name}: ${FLAG_NAME_MESSAGE}`);
          const previous = change.before ? String(change.before.name) : undefined;
          void afterCommit(() => {
            if (previous !== undefined) rows.delete(previous);
            if (change.after) rows.set(name, ruleOfRow(change.after));
            apply();
          });
        },
      });
      ctx.app.onStop(() => {
        clearInterval(timer);
        stopObserving();
      });
    }
    const evaluator = flagEvaluator(() => rules, ctx.logger, { provider: () => slot.current, onEvaluate: ctx.options.onEvaluate });
    evaluators.set(ctx.options, evaluator);
    const gates = routeGates(ctx.models, ctx.options.gate);
    const middleware: HandlerMiddleware = {
      stage: "handler",
      order: -50_000,
      run(req, _res, next) {
        const flags = requestFlags(req, evaluator);
        (req as { flags: unknown }).flags = flags;
        // A route behind a flag that is off for the caller answers like an unknown route, before any hook runs.
        const gate = gates(req.method, req.route);
        if (gate !== undefined && !flags.on(gate)) throw new HttpError(404, "Route not found");
        return next();
      },
    };
    ctx.app.use(middleware);
    // Jobs and queue consumers read flags for the user and tenant they pass, anonymous without them.
    setContextFlags({
      on: (name, target) => evaluator.evaluate(name, subjectOf(target)).on,
      off: (name, target) => !evaluator.evaluate(name, subjectOf(target)).on,
      all: (target) => evaluator.all(subjectOf(target)),
    });
    ctx.app.onStop(() => setContextFlags(undefined));
  },
  openapi(doc, { models, options, routes }) {
    return markGatedOperations(doc, models, routes, options.gate);
  },
  api: (ctx): FlagsApi => {
    const evaluator = evaluators.get(ctx.options)!;
    const slot = providers.get(ctx.options)!;
    return {
      onEvaluate: (fn) => ctx.addHook("onEvaluate", fn as never),
      setProvider(provider) {
        if (typeof provider?.isOn !== "function" || typeof provider.all !== "function") throw new Error("flags setProvider() expects a FlagProvider with the methods isOn, all");
        const caller = ctx.currentFeature() ?? "a feature";
        if (slot.owner !== undefined) throw new Error(`Flag provider set by ${slot.owner} and ${caller}; keep one`);
        slot.owner = caller;
        slot.current = provider;
      },
      isOn: (name, context) => evaluator.evaluate(name, subjectOf(context)).on,
      all: (context) => evaluator.all(subjectOf(context)),
    };
  },
});

/** Adds `x-feature-flag: "<name>"` to each operation behind a flag, so readers know it may answer 404. */
function markGatedOperations(doc: OpenApiDoc, models: readonly EntityModel[], routes: readonly { method: string; path: string; tags?: ParsedTags }[], globalGate: string | undefined): OpenApiDoc {
  const tagged = new Map(routes.map((route) => [`${route.method.toUpperCase()} ${route.path.replace(/\[([^\]]+)\]/g, "{$1}")}`, route.tags]));
  for (const [path, item] of Object.entries(doc.paths)) {
    const route = path.replace(/\{([^}]+)\}/g, "[$1]");
    for (const [method, operation] of Object.entries(item as Record<string, Record<string, unknown>>)) {
      if (typeof operation !== "object" || operation === null) continue;
      const key = `${method.toUpperCase()} ${path}`;
      const tags = tagged.has(key) ? tagged.get(key) : entityOfRoute(models, route)?.tags;
      const gate = gateOf(tags, globalGate);
      if (gate !== undefined) operation["x-feature-flag"] = gate;
    }
  }
  return doc;
}

/** The provider of a running configuration, and who set it. */
interface ProviderSlot {
  current?: FlagProvider;
  owner?: string;
}

/** The provider slot of each running configuration, which features fill with `setProvider`. */
const providers = new WeakMap<object, ProviderSlot>();

/** The fields of `FeatureFlag` the native reads, with their types as the build shows them. */
const REQUIRED_FIELDS: [string, string, (field: EntityModel["fields"][number]) => boolean][] = [
  ["name", "string", (field) => field.type === "string"],
  ["enabled", "boolean", (field) => field.type === "boolean"],
  ["users", "string[]", (field) => field.type === "array" && field.items.type === "string"],
  ["tenants", "string[]", (field) => field.type === "array" && field.items.type === "string"],
  ["percentage", "number", (field) => field.type === "number"],
  ["description", "string", (field) => field.type === "string"],
];

/** Fails when a project's `FeatureFlag` lacks a field the native reads, or gives it another type. */
function assertFlagFields(model: EntityModel): void {
  for (const [name, type, matches] of REQUIRED_FIELDS) {
    const field = model.fields.find((candidate) => candidate.name === name);
    if (!field || !matches(field)) throw new Error(`entities/FeatureFlag.ts: FeatureFlag needs the field ${name} (${type}) used by flags`);
  }
}

/** The evaluator of each running configuration, for its feature API. */
const evaluators = new WeakMap<object, ReturnType<typeof flagEvaluator>>();

export default flagsFeature;
export { flagsFeature };
export { bucketOf, evaluateRule, FLAG_NAME } from "./evaluate.ts";
export type { FlagReason, FlagResult, FlagRule, FlagSubject } from "./evaluate.ts";
export type { FlagContext, FlagProvider, FlagProviderContext, FlagsApi, RequestFlagEvaluator } from "./api.ts";
