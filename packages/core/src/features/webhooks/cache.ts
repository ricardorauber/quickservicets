import { safeLog, type Logger } from "../public.ts";
import { patternMatchesType } from "./deliverable.ts";
import type { StoredSubscription } from "./subscriptions.ts";

/** How often each worker reloads the enabled subscriptions. */
export const CACHE_REFRESH_MS = 30_000;

/** The tenant key of tenant-less subscriptions and events. */
const NO_TENANT = "\u0000";

/** One enabled subscription with its patterns, as the cache keeps it. */
interface Entry {
  subscription: StoredSubscription;
  matches: (type: string) => boolean;
}

/**
 * The enabled subscriptions of one worker, grouped by tenant with their patterns compiled, so matching an event reads
 * no database: loaded at start, reloaded every 30 seconds and right after this worker changes one.
 */
export function subscriptionCache(options: { load: () => Promise<StoredSubscription[]>; logger: Logger; now?: () => number }) {
  const now = options.now ?? Date.now;
  let byTenant = new Map<string, Entry[]>();
  let loadedAt = Number.NEGATIVE_INFINITY;
  let loading: Promise<void> | undefined;
  const entryOf = (subscription: StoredSubscription): Entry => {
    const patterns = [...subscription.events];
    // Each type is matched against the patterns once, then remembered.
    const known = new Map<string, boolean>();
    return {
      subscription,
      matches(type) {
        let found = known.get(type);
        if (found === undefined) known.set(type, (found = patterns.some((pattern) => patternMatchesType(pattern, type))));
        return found;
      },
    };
  };
  const reload = async () => {
    const started = now();
    const rows = await options.load();
    const next = new Map<string, Entry[]>();
    for (const row of rows) {
      if (!row.enabled) continue;
      const key = row.tenant ?? NO_TENANT;
      let list = next.get(key);
      if (!list) next.set(key, (list = []));
      list.push(entryOf(row));
    }
    byTenant = next;
    loadedAt = started;
  };
  return {
    /** Loads the subscriptions again; concurrent calls share one load. */
    refresh(): Promise<void> {
      const run = (loading ??= reload().finally(() => (loading = undefined)));
      return run.catch((error: unknown) => {
        safeLog(options.logger, "error", { timestamp: new Date().toISOString(), message: "webhooks.cache.failed", error: { message: (error as Error)?.message ?? String(error) } });
      });
    },
    /** Reloads when the last load is 30 seconds old or more, in the background. */
    refreshIfDue(): void {
      if (now() - loadedAt >= CACHE_REFRESH_MS) void this.refresh();
    },
    /** The enabled subscriptions of the tenant (none for tenant-less events) whose patterns match the type. */
    matching(type: string, tenant: string | undefined): StoredSubscription[] {
      const list = byTenant.get(tenant ?? NO_TENANT);
      if (!list) return [];
      return list.filter((entry) => entry.matches(type)).map((entry) => entry.subscription);
    },
    /** How many subscriptions are cached, for tests. */
    size(): number {
      let count = 0;
      for (const list of byTenant.values()) count += list.length;
      return count;
    },
  };
}

export type SubscriptionCache = ReturnType<typeof subscriptionCache>;
