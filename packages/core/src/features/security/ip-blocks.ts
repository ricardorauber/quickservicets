import { cidrMatcher, isCidr, matchesCidr, parseDuration, runAfterHooks, safeLog, type DatabaseAdapter, type EntityModel, type FeatureHook, type FieldModel, type Logger, type StoredRecord } from "../public.ts";

/** One temporary block of an address or a network. */
export interface IpBlock {
  /** The blocked address or CIDR block, as given (`/32` or `/128` for automatic blocks). */
  cidr: string;
  /** When the block stops applying. */
  until: Date;
  /** Why: `manual` by default, the caller's reason, or the automatic rule that fired. */
  reason: string;
  source: "manual" | "auto";
  createdAt: Date;
}

/** What `onBlock` hooks and the `security.ip.blocked` entry carry. */
export interface IpBlockEvent {
  cidr: string;
  reason: string;
  source: "manual" | "auto";
  until: Date;
}

/** What `onUnblock` hooks and the `security.ip.unblocked` entry carry. */
export interface IpUnblockEvent {
  cidr: string;
  reason: "manual" | "expired";
  /** The `until` the block had. */
  until: Date;
}

/** Blocking, unblocking and listing temporary blocks, from code. */
export interface IpBlocks {
  /** Blocks an address or a CIDR block for a duration (`for`, like `"15m"`), replacing a block of the same `cidr`. */
  block(target: string, options: { for: string; reason?: string }): Promise<IpBlock>;
  /** Removes the block with exactly that `cidr`; resolves whether one existed. */
  unblock(target: string): Promise<boolean>;
  /** The blocks still in effect. */
  blocked(): Promise<IpBlock[]>;
}

/** The message of `ipBlocks` while the `ip` item is disabled. */
export const IP_DISABLED = "ipBlocks needs security.ip enabled";

/** The system entity of the database store of blocks. */
export function ipBlockEntity(): EntityModel {
  const fields = [
    { name: "cidr", type: "string", optional: false, storage: "column", unique: true },
    { name: "until", type: "date", optional: false, storage: "column" },
    { name: "reason", type: "string", optional: false, storage: "column" },
    { name: "source", type: "string", optional: false, storage: "column" },
  ] as FieldModel[];
  const include = ["id", "createdAt", "updatedAt", ...fields.map((field) => field.name)];
  return {
    key: "IpBlock",
    entityName: "IpBlock",
    schema: null,
    name: "ip-blocks",
    repoKey: "ipBlocks",
    tableName: "ip_blocks",
    fields,
    hooks: [],
    overrideHooks: "inherit",
    internal: true,
    exposure: { list: { include, exclude: [] }, read: { include, exclude: [] } },
    indexes: [{ fields: ["until"] }],
    system: true,
    tenancy: "shared",
  };
}

const copy = (block: IpBlock): IpBlock => ({ ...block, until: new Date(block.until), createdAt: new Date(block.createdAt) });
const blockOf = (record: StoredRecord): IpBlock => ({
  cidr: String(record.cidr),
  until: new Date(record.until as string | number | Date),
  reason: String(record.reason),
  source: record.source === "auto" ? "auto" : "manual",
  createdAt: new Date(record.createdAt as string | number | Date),
});

/** The settings of a block list. */
export interface IpBlockListOptions {
  maxEntries: number;
  logger: Logger;
  onBlock: readonly FeatureHook<IpBlockEvent, undefined>[];
  onUnblock: readonly FeatureHook<IpUnblockEvent, undefined>[];
  /** The database store: blocks are written to the entity and read back every `syncInterval`. */
  database?: { adapter: DatabaseAdapter; model: EntityModel };
  now?: () => number;
}

/**
 * The temporary blocks of one worker: kept in memory (bounded by `maxEntries`, the block closest to expiry evicted
 * first) and, with the database store, written through to the `IpBlock` entity and reloaded on `sync`. The check reads
 * memory only: a matcher of the blocks in effect, rebuilt when the blocks change or the next one expires.
 */
export class IpBlockList implements IpBlocks {
  private readonly entries = new Map<string, IpBlock>();
  private matcher: ((address: string) => boolean) | undefined;
  private nextExpiry = Number.POSITIVE_INFINITY;
  private dirty = false;
  private readonly now: () => number;

  constructor(private readonly options: IpBlockListOptions) {
    this.now = options.now ?? Date.now;
  }

  /** How many blocks are stored, expired ones not yet removed included; the request check skips everything at 0. */
  get size(): number {
    return this.entries.size;
  }

  /** Whether an address matches a block in effect. */
  matches(address: string): boolean {
    const now = this.now();
    if (this.dirty || now >= this.nextExpiry) this.rebuild(now);
    return this.matcher?.(address) ?? false;
  }

  private rebuild(now: number): void {
    const active: string[] = [];
    let next = Number.POSITIVE_INFINITY;
    for (const block of this.entries.values()) {
      const until = block.until.getTime();
      if (until <= now) continue;
      active.push(block.cidr);
      if (until < next) next = until;
    }
    this.matcher = active.length > 0 ? cidrMatcher(active) : undefined;
    this.nextExpiry = next;
    this.dirty = false;
  }

  /** Puts a block in memory, evicting the one closest to expiry past `maxEntries`. */
  private remember(block: IpBlock): void {
    if (!this.entries.has(block.cidr) && this.entries.size >= this.options.maxEntries) {
      let soonest: IpBlock | undefined;
      for (const entry of this.entries.values()) if (!soonest || entry.until < soonest.until) soonest = entry;
      if (soonest) this.entries.delete(soonest.cidr);
    }
    this.entries.set(block.cidr, block);
    this.dirty = true;
  }

  async block(target: string, options: { for: string; reason?: string }, source: "manual" | "auto" = "manual"): Promise<IpBlock> {
    const cidr = checkedTarget("block", target);
    const ms = typeof options?.for === "string" ? parseDuration(options.for) : undefined;
    if (ms === undefined || !(ms > 0)) throw new TypeError('block() needs for, like "15m"');
    const now = this.now();
    const existing = this.entries.get(cidr);
    const until = new Date(Math.max(now + ms, existing && existing.until.getTime() > now ? existing.until.getTime() : 0));
    const block: IpBlock = { cidr, until, reason: options.reason ?? "manual", source, createdAt: new Date(now) };
    const database = this.options.database;
    if (database) {
      const stored = await database.adapter.findOne(database.model, [{ field: "cidr", op: "eq", value: cidr }]);
      const values = { until, reason: block.reason, source, updatedAt: new Date(now) };
      if (stored) await database.adapter.updateById(database.model, stored.id, values);
      else await database.adapter.insert(database.model, { id: Bun.randomUUIDv7(), createdAt: new Date(now), cidr, ...values } as StoredRecord);
    }
    this.remember(block);
    const event: IpBlockEvent = { cidr, reason: block.reason, source, until };
    safeLog(this.options.logger, "warn", { timestamp: new Date(now).toISOString(), message: "security.ip.blocked", cidr, reason: block.reason, source, until: until.toISOString() });
    if (this.options.onBlock.length > 0) await runAfterHooks(this.options.onBlock, event, undefined);
    return copy(block);
  }

  async unblock(target: string): Promise<boolean> {
    const cidr = checkedTarget("unblock", target);
    const database = this.options.database;
    let until = this.entries.get(cidr)?.until;
    if (database) {
      const stored = await database.adapter.findOne(database.model, [{ field: "cidr", op: "eq", value: cidr }]);
      if (stored) {
        until ??= new Date(stored.until as string | number | Date);
        await database.adapter.deleteById(database.model, stored.id);
      }
    }
    if (until === undefined) return false;
    this.entries.delete(cidr);
    this.dirty = true;
    await this.unblocked({ cidr, reason: "manual", until });
    return true;
  }

  async blocked(): Promise<IpBlock[]> {
    const now = this.now();
    return [...this.entries.values()].filter((block) => block.until.getTime() > now).map(copy);
  }

  private async unblocked(event: IpUnblockEvent): Promise<void> {
    safeLog(this.options.logger, "info", { timestamp: new Date(this.now()).toISOString(), message: "security.ip.unblocked", cidr: event.cidr, reason: event.reason, until: event.until.toISOString() });
    if (this.options.onUnblock.length > 0) await runAfterHooks(this.options.onUnblock, event, undefined);
  }

  /** Replaces the memory blocks with the active ones of the entity (database store). */
  async sync(): Promise<void> {
    const database = this.options.database;
    if (!database) return;
    const now = this.now();
    const fresh = new Map<string, IpBlock>();
    for (let offset = 0; ; offset += 1000) {
      const { data } = await database.adapter.findMany(database.model, { where: [{ field: "until", op: "gt", value: new Date(now) }], sort: [{ field: "until", direction: "desc" }], limit: 1000, offset, withTotal: false });
      for (const record of data as StoredRecord[]) if (fresh.size < this.options.maxEntries) fresh.set(String(record.cidr), blockOf(record));
      if (data.length < 1000) break;
    }
    this.entries.clear();
    for (const [cidr, block] of fresh) this.entries.set(cidr, block);
    this.dirty = true;
  }

  /**
   * Removes the expired blocks and logs each: from memory, and with `fromDatabase` from the entity too (one worker per
   * process does that). Resolves how many were removed.
   */
  async cleanup(fromDatabase: boolean): Promise<number> {
    const now = this.now();
    const expired: IpUnblockEvent[] = [];
    const database = fromDatabase ? this.options.database : undefined;
    if (database) {
      const { data } = await database.adapter.findMany(database.model, { where: [{ field: "until", op: "lte", value: new Date(now) }], sort: [{ field: "until", direction: "asc" }], limit: 1000, offset: 0, withTotal: false });
      for (const record of data as StoredRecord[]) {
        if (await database.adapter.deleteById(database.model, record.id)) expired.push({ cidr: String(record.cidr), reason: "expired", until: new Date(record.until as string | number | Date) });
      }
    }
    for (const block of [...this.entries.values()]) {
      if (block.until.getTime() > now) continue;
      this.entries.delete(block.cidr);
      this.dirty = true;
      // Without the database store, each worker owns its blocks and logs their expiry.
      if (!this.options.database) expired.push({ cidr: block.cidr, reason: "expired", until: block.until });
    }
    for (const event of expired) await this.unblocked(event);
    return expired.length;
  }
}

/** A target of `block` or `unblock`: an address, a CIDR block or `loopback`, `private` or `linklocal`. */
function checkedTarget(method: string, target: unknown): string {
  if (typeof target !== "string" || !isCidr(target)) throw new TypeError(`${method}(): expected an IP address or a CIDR block, got ${JSON.stringify(target)}`);
  return target;
}

/** The settings of automatic blocking. */
export interface AutoBlockOptions {
  after: number;
  withinMs: number;
  forText: string;
  withinText: string;
  statuses: readonly number[];
  maxEntries: number;
  now?: () => number;
}

/** One address's counts in the sliding window. */
interface Counter {
  windowStart: number;
  previous: number;
  current: number;
}

/**
 * Counts the listed answers per address with a sliding window over `within` and blocks the address for `for` once the
 * estimate reaches `after`; the counters are bounded by `maxEntries`, the least recently used evicted first.
 */
export class AutoBlocker {
  private readonly counters = new Map<string, Counter>();
  readonly statuses: ReadonlySet<number>;
  readonly reason: string;
  private readonly now: () => number;

  constructor(
    private readonly options: AutoBlockOptions,
    private readonly blocks: IpBlockList,
    private readonly logger: Logger,
  ) {
    this.statuses = new Set(options.statuses);
    this.reason = `auto: ${options.after} responses with ${options.statuses.join(",")} within ${options.withinText}`;
    this.now = options.now ?? Date.now;
  }

  /** Counts one listed answer to `address`; blocks it when the count reaches the threshold. */
  count(address: string): void {
    const now = this.now();
    const windowMs = this.options.withinMs;
    let counter = this.counters.get(address);
    if (counter) this.counters.delete(address);
    else {
      counter = { windowStart: now - (now % windowMs), previous: 0, current: 0 };
      if (this.counters.size >= this.options.maxEntries) this.counters.delete(this.counters.keys().next().value!);
    }
    const start = now - (now % windowMs);
    if (start !== counter.windowStart) {
      counter.previous = start - counter.windowStart === windowMs ? counter.current : 0;
      counter.current = 0;
      counter.windowStart = start;
    }
    counter.current += 1;
    const estimate = counter.previous * (1 - (now - start) / windowMs) + counter.current;
    if (estimate >= this.options.after) {
      const cidr = address.includes(":") ? `${address}/128` : `${address}/32`;
      void this.blocks.block(cidr, { for: this.options.forText, reason: this.reason }, "auto").catch((error: unknown) =>
        safeLog(this.logger, "error", { timestamp: new Date().toISOString(), message: "security.ip.autoBlock.failed", cidr, error: { message: (error as Error)?.message ?? String(error) } }),
      );
      return;
    }
    this.counters.set(address, counter);
  }
}

/** Whether automatic blocking may never touch an address: loopback and `unknown`. */
export const neverAutoBlocked = (address: string) => address === "unknown" || matchesCidr(address, "loopback");

const HUB = Symbol.for("quickservicets.ipBlocks.hub");
const hubSlot = globalThis as unknown as { [HUB]?: IpBlocks };

/** Sets the blocks `ipBlocks` reaches (the security native sets it); with `undefined`, removes `owner`'s only. */
export function setIpBlocksHub(hub: IpBlocks | undefined, owner?: IpBlocks): void {
  if (hub === undefined && owner !== undefined && hubSlot[HUB] !== owner) return;
  hubSlot[HUB] = hub;
}

const current = (): IpBlocks => {
  const hub = hubSlot[HUB];
  if (!hub) throw new Error(IP_DISABLED);
  return hub;
};

/** Temporary blocks from any code, like `ctx.feature("security").ip`; throws while `security.ip` is disabled. */
export const ipBlocks: IpBlocks = {
  block: (target, options) => current().block(target, options),
  unblock: (target) => current().unblock(target),
  blocked: () => current().blocked(),
};
