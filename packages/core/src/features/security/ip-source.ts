import { afterCommit, cidrMatcher, isCidr, observeWrites, safeLog, type DatabaseAdapter, type EntityModel, type Logger, type StoredRecord } from "../public.ts";
import { compileLists, type CompileList, type IpLists } from "./ip.ts";

/**
 * Where the `ip` item's lists come from while the service runs, like a database table or a threat feed: `load`
 * resolves the current lists, and `watch`, when given, calls `onChange` whenever they changed and returns a function
 * that stops watching.
 */
export interface IpListSource {
  load(): Promise<{ allow: string[]; deny: string[] }>;
  watch?(onChange: () => void): () => void;
}

/** How many entries of each list are in effect. */
export interface IpListCounts {
  allow: number;
  deny: number;
}

/** What a source that reads the project's database is given at setup; the security native calls it. */
export const BIND_SOURCE = Symbol.for("quickservicets.ipListSource.bind");

/** The setup a database-backed source needs. */
export interface IpSourceSetup {
  models: readonly EntityModel[];
  database: DatabaseAdapter;
}

/** The lists the `ip` item checks, which a source replaces while the service runs. */
export interface DynamicIpLists {
  /** The compiled check in effect: whether an address passes the global lists; undefined lets every address pass. */
  readonly check: ((address: string) => boolean) | undefined;
  /** Whether an address matches an allow list in effect, the config's or the loaded one. */
  allows(address: string): boolean;
  /** Loads the source now (after a load in flight, if any) and resolves the counts once the new lists are in effect. */
  reload(): Promise<IpListCounts>;
  /** Loads once, then on every `refresh` and every `watch` notification; a failed first load keeps the config lists. */
  start(): Promise<void>;
  stop(): void;
}

/** How often each kind of source problem is logged at most. */
const LOG_EVERY_MS = 60_000;

/**
 * The lists of a source merged with the config's: each successful load validates the entries (skipping and logging the
 * invalid ones), compiles the merged lists and swaps them in with one assignment, so a request sees either the old or
 * the new lists. A load that fails or takes longer than `refreshMs` keeps the lists in effect. Loads never overlap: a
 * trigger during a load runs one more load after it.
 */
export function dynamicIpLists(options: { config: IpLists; source: IpListSource; refreshMs: number; logger: Logger; compile?: CompileList; now?: () => number }): DynamicIpLists {
  const { config, source, refreshMs, logger } = options;
  const compile = options.compile ?? cidrMatcher;
  const now = options.now ?? Date.now;
  const lastLogged = new Map<string, number>();
  /** Logs at most once per minute for each key. */
  const throttled = (key: string, level: "warn" | "error", entry: Record<string, unknown>) => {
    const at = now();
    const last = lastLogged.get(key);
    if (last !== undefined && at - last < LOG_EVERY_MS) return;
    if (lastLogged.size > 10_000) lastLogged.clear();
    lastLogged.set(key, at);
    safeLog(logger, level, { timestamp: new Date(at).toISOString(), ...entry });
  };
  const valid = (entries: unknown): string[] => {
    if (!Array.isArray(entries)) return [];
    const kept: string[] = [];
    for (const entry of entries) {
      if (typeof entry === "string" && isCidr(entry)) kept.push(entry);
      else throttled(`invalid:${String(entry)}`, "warn", { message: "security.ip.source.invalid", entry: String(entry) });
    }
    return kept;
  };
  const allowOf = (entries: readonly string[]) => (entries.length > 0 ? compile(entries) : undefined);
  const state: { check: ((address: string) => boolean) | undefined; allowed: ((address: string) => boolean) | undefined } = { check: compileLists(config, compile), allowed: undefined };
  let configAllowed: ((address: string) => boolean) | undefined | null = null;
  let counts: IpListCounts = { allow: config.allow.length, deny: config.deny.length };

  /** One load: within `refreshMs`, then validated, merged, compiled and swapped in. */
  const run = async (): Promise<IpListCounts> => {
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the load took longer than ${refreshMs}ms`)), refreshMs);
      });
      let loaded: { allow: string[]; deny: string[] };
      try {
        loaded = await Promise.race([Promise.resolve().then(() => source.load()), late]);
      } finally {
        clearTimeout(timer);
      }
      const merged: IpLists = { allow: [...config.allow, ...valid(loaded?.allow)], deny: [...config.deny, ...valid(loaded?.deny)] };
      const compiled = compileLists(merged, compile);
      state.check = compiled;
      state.allowed = merged.allow.length > config.allow.length ? allowOf(merged.allow) : undefined;
      counts = { allow: merged.allow.length, deny: merged.deny.length };
      return counts;
    } catch (error) {
      throttled("failed", "error", { message: "security.ip.source.failed", reason: (error as Error)?.message ?? String(error) });
      throw error;
    }
  };

  let current: Promise<IpListCounts> | undefined;
  let next: { promise: Promise<IpListCounts>; resolve: (counts: IpListCounts) => void; reject: (error: unknown) => void } | undefined;
  const begin = (): Promise<IpListCounts> => {
    const running = run();
    current = running;
    const settle = () => {
      current = undefined;
      const waiting = next;
      next = undefined;
      if (waiting) begin().then(waiting.resolve, waiting.reject);
    };
    running.then(settle, settle);
    return running;
  };
  const trigger = (): Promise<IpListCounts> => {
    if (!current) return begin();
    if (!next) {
      let resolve!: (counts: IpListCounts) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<IpListCounts>((ok, fail) => ((resolve = ok), (reject = fail)));
      next = { promise, resolve, reject };
    }
    return next.promise;
  };
  const background = () => void trigger().catch(() => undefined);

  let timer: ReturnType<typeof setInterval> | undefined;
  let unwatch: (() => void) | undefined;
  return {
    get check() {
      return state.check;
    },
    allows(address) {
      if (state.allowed) return state.allowed(address);
      // Until a load brings allow entries, the config's allow list is the one in effect; compiled when first asked.
      if (configAllowed === null) configAllowed = allowOf(config.allow);
      return configAllowed?.(address) ?? false;
    },
    reload: trigger,
    async start() {
      await trigger().catch(() => undefined);
      timer = setInterval(background, refreshMs);
      timer.unref?.();
      unwatch = source.watch?.(background);
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
      unwatch?.();
      unwatch = undefined;
    },
  };
}

/**
 * A source reading the `ip` lists from a project entity with the fields `cidr` (string), `list` (`"allow"` or
 * `"deny"`), `expiresAt?` (date) and `note?` (string), so admins manage them through the entity's normal routes:
 * expired records are skipped, records are read in the root scope, and every committed write to the entity in this
 * process reloads the lists at once (other processes see it at the next `refresh`).
 */
export function databaseIpList(options: { entity: string }): IpListSource {
  const name = options?.entity;
  if (typeof name !== "string" || name === "") throw new Error("databaseIpList() needs the entity's name, like databaseIpList({ entity: \"IpRule\" })");
  let bound: { model: EntityModel; database: DatabaseAdapter } | undefined;
  const source: IpListSource & { [BIND_SOURCE](setup: IpSourceSetup): void } = {
    [BIND_SOURCE](setup) {
      const model = setup.models.find((candidate) => candidate.key === name);
      const fields = new Set(model?.fields.map((field) => field.name) ?? []);
      if (!model || !fields.has("cidr") || !fields.has("list")) throw new Error(`databaseIpList: entity ${name} needs the fields cidr and list`);
      bound = { model, database: setup.database };
    },
    async load() {
      if (!bound) throw new Error("databaseIpList is not set up; use it as security.ip.source");
      const lists = { allow: [] as string[], deny: [] as string[] };
      const at = Date.now();
      for (let offset = 0; ; offset += 1000) {
        const { data } = await bound.database.findMany(bound.model, { where: [], sort: [{ field: "id", direction: "asc" }], limit: 1000, offset, withTotal: false });
        for (const row of data as StoredRecord[]) {
          const expiresAt = row.expiresAt;
          if (expiresAt !== undefined && expiresAt !== null && new Date(expiresAt as string | number | Date).getTime() <= at) continue;
          if (row.list === "allow") lists.allow.push(String(row.cidr));
          else if (row.list === "deny") lists.deny.push(String(row.cidr));
        }
        if (data.length < 1000) return lists;
      }
    },
    watch(onChange) {
      if (!bound) return () => undefined;
      return observeWrites({
        entities: [bound.model.key],
        write() {
          void afterCommit(onChange);
        },
      });
    },
  };
  return source;
}
