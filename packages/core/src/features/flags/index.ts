import {
  defineFeature,
  duration,
  entityRoutePath,
  afterCommit,
  HttpError,
  integer,
  observeWrites,
  parseDuration,
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
  type HandlerMiddleware,
  type Logger,
  type OpenApiDoc,
  type ParsedTags,
  type ServiceRequest,
} from "../public.ts";
import type { FlagContext, FlagsApi, RequestFlagEvaluator } from "./api.ts";
import { evaluateRule, FLAG_NAME, FLAG_NAME_MESSAGE, idOf, type FlagResult, type FlagRule, type FlagSubject } from "./evaluate.ts";
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
    }).describe("One flag: true or false for everyone, or who it is on for."),
  )
    .keys(FLAG_NAME, FLAG_NAME_MESSAGE)
    .describe("The flags by name: lowercase letters, digits, _ and -."),
  refresh: duration().default("30s").describe("How often each worker reloads the flags of the database source."),
  gate: string()
    .optional()
    .describe("A flag every route needs: while it is off for a caller, every route answers 404; set per endpoint or entity with @flag."),
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

/** The rules of the running service, by name. */
export type FlagRules = ReadonlyMap<string, FlagRule>;

/** Evaluates flags against a set of rules, warning once per process about each unknown name. */
export function flagEvaluator(rules: () => FlagRules, logger: Logger) {
  const warned = new Set<string>();
  const evaluate = (name: string, subject: FlagSubject): FlagResult => {
    const rule = rules().get(name);
    if (!rule) {
      if (!warned.has(name)) {
        warned.add(name);
        safeLog(logger, "warn", { timestamp: new Date().toISOString(), message: "flags.unknown", flag: name });
      }
      return { on: false, reason: "unknown" };
    }
    return evaluateRule(name, rule, subject);
  };
  const all = (subject: FlagSubject): Record<string, boolean> => Object.fromEntries([...rules().keys()].map((name) => [name, evaluate(name, subject).on]));
  return { evaluate, all };
}

const subjectOf = (context: FlagContext = {}): FlagSubject => {
  const userId = idOf(context.user);
  const tenantId = idOf(context.tenant);
  return { ...(userId !== undefined ? { userId } : {}), ...(tenantId !== undefined ? { tenantId } : {}) };
};

/** The evaluator of one request: synchronous, reading the request's user and tenant when asked, each name evaluated once. */
export function requestFlags(req: ServiceRequest, evaluator: ReturnType<typeof flagEvaluator>): RequestFlagEvaluator {
  const memo = new Map<string, boolean>();
  const on = (name: string) => {
    let value = memo.get(name);
    if (value === undefined) {
      value = evaluator.evaluate(name, subjectOf({ user: req.user, tenant: req.tenant })).on;
      memo.set(name, value);
    }
    return value;
  };
  return {
    on,
    off: (name) => !on(name),
    all: () => evaluator.all(subjectOf({ user: req.user, tenant: req.tenant })),
  };
}

/** The rules of the resolved options, `true` and `false` included. */
export function configRules(rules: Readonly<Record<string, unknown>>): FlagRules {
  return new Map(Object.entries(rules).map(([name, rule]) => [name, rule as FlagRule]));
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
  entities: ({ options }) => (options.source === "database" ? [featureFlagEntity()] : []),
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
    const evaluator = flagEvaluator(() => rules, ctx.logger);
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
    return {
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

/** The evaluator of each running configuration, for its feature API. */
const evaluators = new WeakMap<object, ReturnType<typeof flagEvaluator>>();

export default flagsFeature;
export { flagsFeature };
export { bucketOf, evaluateRule, FLAG_NAME } from "./evaluate.ts";
export type { FlagReason, FlagResult, FlagRule, FlagSubject } from "./evaluate.ts";
export type { FlagContext, FlagsApi, RequestFlagEvaluator } from "./api.ts";
