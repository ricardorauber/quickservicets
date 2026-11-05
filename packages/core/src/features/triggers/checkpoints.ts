import { randomUUID } from "node:crypto";
import { UniqueViolationError, type Condition, type DatabaseAdapter, type EntityModel, type FieldModel } from "../public.ts";

/** The shared system entity of partition leases and positions: one record per trigger and partition. */
export const triggerCheckpointEntity: EntityModel = (() => {
  const fields = [
    { name: "trigger", type: "string", optional: false, storage: "column" },
    { name: "partition", type: "string", optional: false, storage: "column" },
    { name: "position", type: "string", optional: true, storage: "column" },
    { name: "owner", type: "string", optional: true, storage: "column" },
    { name: "leaseUntil", type: "date", optional: true, storage: "column" },
  ] as FieldModel[];
  const include = ["id", "createdAt", "updatedAt", ...fields.map((field) => field.name)];
  return {
    key: "TriggerCheckpoint",
    entityName: "TriggerCheckpoint",
    schema: null,
    name: "trigger-checkpoints",
    repoKey: "triggerCheckpoints",
    tableName: "trigger_checkpoints",
    fields,
    hooks: [],
    overrideHooks: "inherit",
    internal: true,
    system: true,
    tenancy: "shared",
    indexes: [{ fields: ["trigger", "partition"], unique: true }],
    exposure: { list: { include, exclude: [] }, read: { include, exclude: [] } },
  } as EntityModel;
})();

/** A partition this worker leases, with the position saved for it (null before the first save). */
export interface ClaimedPartition {
  partition: string;
  position: string | null;
}

/**
 * The partition leases and positions of one trigger, `ctx.checkpoints` of a poll: each partition is read by one worker
 * at a time, and resumed from its saved position by another once the lease of a worker that crashed expires.
 */
export interface TriggerCheckpoints {
  /** Leases the free (or expired, or already held) partitions among `partitions` for `ttl`; resolves those this worker holds. */
  claim(partitions: readonly string[], options: { ttl: string }): Promise<ClaimedPartition[]>;
  /** Extends the leases this worker holds by their ttl; resolves the partitions still held. */
  renew(): Promise<string[]>;
  /** Saves a partition's position, only while this worker holds its lease; resolves whether it was saved. */
  save(partition: string, position: string): Promise<boolean>;
  /** Gives a partition up at once, so another worker claims it without waiting for the lease to expire. */
  release(partition: string): Promise<void>;
  /** Gives every held partition up. */
  releaseAll(): Promise<void>;
  /** The partitions this worker holds. */
  held(): string[];
}

/** What a checkpoint store needs. */
export interface CheckpointStoreOptions {
  adapter: DatabaseAdapter;
  /** The trigger whose partitions are leased. */
  trigger: string;
  /** This worker's identity (default: a random one). */
  owner?: string;
  model?: EntityModel;
  now?: () => number;
  parse: (duration: string) => number | undefined;
}

const condition = (field: string, op: "eq" | "lt" | "isNull", value?: unknown): Condition => ({ field, op, value }) as Condition;

/** The message of a poll that uses checkpoints while the project has no TriggerCheckpoint entity. */
export const MISSING_CHECKPOINTS = "Trigger checkpoints need the TriggerCheckpoint entity: add triggerCheckpointEntity to the entities of the feature that registers the polling source, then run quickservicets build";

/**
 * The checkpoints of one trigger, kept in the project's database: `claim` leases partitions with a conditional write
 * (two workers racing for one partition never both win), `save` changes a position only while this worker is its
 * owner, and `release` frees a partition at once.
 */
export function checkpointStore(options: CheckpointStoreOptions): TriggerCheckpoints {
  const model = options.model ?? triggerCheckpointEntity;
  const owner = options.owner ?? randomUUID();
  const now = options.now ?? Date.now;
  /** The partitions this worker holds: their record id and lease length. */
  const held = new Map<string, { id: string; ttl: number }>();
  const keyOf = (partition: string) => [condition("trigger", "eq", options.trigger), condition("partition", "eq", partition)];
  const take = async (partition: string, ttl: number): Promise<ClaimedPartition | undefined> => {
    const at = now();
    const leaseUntil = new Date(at + ttl);
    let existing = await options.adapter.findOne(model, keyOf(partition));
    if (!existing) {
      try {
        const id = randomUUID();
        await options.adapter.insert(model, { id, createdAt: new Date(at), updatedAt: new Date(at), trigger: options.trigger, partition, position: null, owner, leaseUntil });
        held.set(partition, { id, ttl });
        return { partition, position: null };
      } catch (error) {
        if (!(error instanceof UniqueViolationError)) throw error;
        // Another worker created it first; its lease decides below.
        existing = await options.adapter.findOne(model, keyOf(partition));
        if (!existing) return undefined;
      }
    }
    const current = existing.owner as string | null | undefined;
    const until = existing.leaseUntil instanceof Date ? existing.leaseUntil.getTime() : existing.leaseUntil ? new Date(existing.leaseUntil as string).getTime() : 0;
    const free = current === null || current === undefined;
    if (!free && current !== owner && until >= at) return undefined;
    // The write only succeeds while the record still has the owner (and expired lease) this worker saw.
    const where = free ? [condition("owner", "isNull", true)] : current === owner ? [condition("owner", "eq", owner)] : [condition("owner", "eq", current), condition("leaseUntil", "lt", new Date(at))];
    const updated = await options.adapter.updateById(model, String(existing.id), { owner, leaseUntil, updatedAt: new Date(at) }, where);
    if (!updated) return undefined;
    held.set(partition, { id: String(existing.id), ttl });
    return { partition, position: (updated.position as string | null | undefined) ?? null };
  };
  return {
    async claim(partitions, { ttl }) {
      const ms = options.parse(ttl);
      if (ms === undefined || ms <= 0) throw new Error(`Invalid checkpoint ttl ${ttl}`);
      const claimed: ClaimedPartition[] = [];
      for (const partition of partitions) {
        const taken = await take(partition, ms);
        if (taken) claimed.push(taken);
      }
      return claimed;
    },
    async renew() {
      for (const [partition, { id, ttl }] of held) {
        const at = now();
        const updated = await options.adapter.updateById(model, id, { leaseUntil: new Date(at + ttl), updatedAt: new Date(at) }, [condition("owner", "eq", owner)]);
        if (!updated) held.delete(partition);
      }
      return [...held.keys()];
    },
    async save(partition, position) {
      const lease = held.get(partition);
      if (!lease) return false;
      const updated = await options.adapter.updateById(model, lease.id, { position, updatedAt: new Date(now()) }, [condition("owner", "eq", owner)]);
      if (!updated) held.delete(partition);
      return updated !== null;
    },
    async release(partition) {
      const lease = held.get(partition);
      if (!lease) return;
      held.delete(partition);
      await options.adapter.updateById(model, lease.id, { owner: null, leaseUntil: null, updatedAt: new Date(now()) }, [condition("owner", "eq", owner)]);
    },
    async releaseAll() {
      for (const partition of [...held.keys()]) await this.release(partition);
    },
    held: () => [...held.keys()],
  };
}
