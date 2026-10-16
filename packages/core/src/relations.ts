import type { DatabaseAdapter, StoredRecord } from "./adapter.ts";
import { HttpError } from "./errors.ts";
import type { EntityModel, FieldModel } from "./model.ts";

type Derived = FieldModel & { relation: NonNullable<FieldModel["relation"]> };

export const isDerived = (field: FieldModel): field is Derived => field.storage === "derived" && field.relation !== undefined;

export const derivedFields = (model: EntityModel): Derived[] => model.fields.filter(isDerived);

export function withoutDerived(model: EntityModel, values: Record<string, unknown>): Record<string, unknown> {
  const names = new Set(derivedFields(model).map((field) => field.name));
  return Object.fromEntries(Object.entries(values).filter(([key]) => !names.has(key)));
}

const byKey = (models: EntityModel[], key: string) => models.find((model) => model.key === key);

/** The link entity storing the N-N relation of `field` on `model`, and which side `model` is. */
export function linkFor(model: EntityModel, field: Derived, models: EntityModel[]) {
  for (const link of models) {
    if (!link.link) continue;
    if (link.link.left.entity === model.key && link.link.left.field === field.name) return { link, side: "left" as const };
    if (link.link.right.entity === model.key && link.link.right.field === field.name) return { link, side: "right" as const };
  }
  throw new Error(`No link entity for ${model.entityName}.${field.name}`);
}

const other = (side: "left" | "right") => (side === "left" ? "right" : "left");

async function all(adapter: DatabaseAdapter, model: EntityModel, where: Parameters<DatabaseAdapter["findMany"]>[1]["where"], sort: Parameters<DatabaseAdapter["findMany"]>[1]["sort"]) {
  const total = await adapter.count(model, where);
  if (total === 0) return [];
  return (await adapter.findMany(model, { where, sort, limit: total, offset: 0 })).data;
}

/** Computes the derived side of every bidirectional relation of `records` (one query per field). */
export async function deriveRelations(
  model: EntityModel,
  records: StoredRecord[],
  models: EntityModel[],
  adapter: DatabaseAdapter,
): Promise<StoredRecord[]> {
  const fields = derivedFields(model);
  if (fields.length === 0 || records.length === 0) return records;
  const result = records.map((record) => ({ ...record }));
  const ids = result.map((record) => record.id);
  for (const field of fields) {
    const { kind, inverseEntity, inverseField } = field.relation;
    if (kind === "N-N") {
      const { link, side } = linkFor(model, field, models);
      const rows = await all(adapter, link, [{ field: side, op: "in", value: ids }], [{ field: `${side}Position`, direction: "asc" }]);
      for (const record of result) {
        record[field.name] = rows.filter((row) => row[side] === record.id).map((row) => row[other(side)] as string);
      }
      continue;
    }
    const target = byKey(models, inverseEntity)!;
    const rows = await all(adapter, target, [{ field: inverseField, op: "in", value: ids }], [
      { field: "createdAt", direction: "asc" },
      { field: "id", direction: "asc" },
    ]);
    for (const record of result) {
      const related = rows.filter((row) => row[inverseField] === record.id).map((row) => row.id);
      record[field.name] = field.type === "refArray" ? related : (related[0] ?? null);
    }
  }
  return result;
}

export type Touch = (model: EntityModel, record: StoredRecord, changes: Record<string, unknown>) => Promise<void>;

/** Applies writes to derived sides of `owner` (already validated and resolved to full lists or ids). */
export async function writeDerived(
  model: EntityModel,
  ownerId: string,
  values: Record<string, unknown>,
  models: EntityModel[],
  adapter: DatabaseAdapter,
  touch: Touch,
): Promise<void> {
  for (const field of derivedFields(model)) {
    if (!(field.name in values)) continue;
    const { kind, inverseEntity, inverseField } = field.relation;
    const target = byKey(models, inverseEntity)!;
    const inverse = target.fields.find((candidate) => candidate.name === inverseField)!;

    if (kind === "N-N") {
      await writeLinks(model, field, ownerId, (values[field.name] as string[] | null) ?? [], models, adapter, touch);
      continue;
    }

    const wanted = field.type === "refArray" ? ((values[field.name] as string[] | null) ?? []) : values[field.name] ? [values[field.name] as string] : [];
    const current = await all(adapter, target, [{ field: inverseField, op: "eq", value: ownerId }], [{ field: "id", direction: "asc" }]);
    for (const record of current) {
      if (wanted.includes(record.id)) continue;
      if (!inverse.optional) {
        throw new HttpError(400, "Invalid body", { details: [{ field: field.name, message: `Cannot unlink: ${inverseField} is required` }] });
      }
      await touch(target, record, { [inverseField]: null });
    }
    for (const id of wanted) {
      const record = await adapter.findById(target, id);
      if (!record || record[inverseField] === ownerId) continue;
      if (kind === "1-1" && record[inverseField] !== null && record[inverseField] !== undefined) {
        if (field.onConflict !== "replace") {
          throw new HttpError(409, "Value already exists", { details: [{ field: field.name, message: "Value already exists" }] });
        }
      }
      await touch(target, record, { [inverseField]: ownerId });
    }
  }
}

async function writeLinks(
  model: EntityModel,
  field: Derived,
  ownerId: string,
  wanted: string[],
  models: EntityModel[],
  adapter: DatabaseAdapter,
  touch: Touch,
): Promise<void> {
  const { link, side } = linkFor(model, field, models);
  const opposite = other(side);
  const target = byKey(models, field.relation.inverseEntity)!;
  const current = await all(adapter, link, [{ field: side, op: "eq", value: ownerId }], [{ field: `${side}Position`, direction: "asc" }]);
  const changedTargets = new Set<string>();
  for (const row of current) {
    if (!wanted.includes(row[opposite] as string)) {
      await adapter.deleteById(link, row.id);
      changedTargets.add(row[opposite] as string);
    }
  }
  for (const [position, targetId] of wanted.entries()) {
    const existing = current.find((row) => row[opposite] === targetId);
    if (existing) {
      if (existing[`${side}Position`] !== position) await adapter.updateById(link, existing.id, { [`${side}Position`]: position });
      continue;
    }
    const others = await all(adapter, link, [{ field: opposite, op: "eq", value: targetId }], [{ field: `${opposite}Position`, direction: "desc" }]);
    const nextPosition = others.length > 0 ? Number(others[0]![`${opposite}Position`]) + 1 : 0;
    const left = side === "left" ? ownerId : targetId;
    const right = side === "left" ? targetId : ownerId;
    const now = new Date();
    await adapter.insert(link, {
      id: Bun.randomUUIDv7(),
      createdAt: now,
      updatedAt: now,
      left,
      right,
      [`${side}Position`]: position,
      [`${opposite}Position`]: nextPosition,
      pair: `${left}:${right}`,
    });
    changedTargets.add(targetId);
  }
  for (const id of changedTargets) {
    const record = await adapter.findById(target, id);
    if (record) await touch(target, record, {});
  }
}

/** Before a storing 1-1 write, frees the target when `@onConflict replace` allows moving the link. */
export async function releaseOneToOne(
  model: EntityModel,
  ownerId: string | undefined,
  values: Record<string, unknown>,
  adapter: DatabaseAdapter,
  touch: Touch,
): Promise<void> {
  for (const field of model.fields) {
    if (field.relation?.kind !== "1-1" || !field.relation.storing || field.onConflict !== "replace") continue;
    const value = values[field.name];
    if (typeof value !== "string") continue;
    const holders = await all(adapter, model, [{ field: field.name, op: "eq", value }], [{ field: "id", direction: "asc" }]);
    for (const holder of holders) {
      if (holder.id === ownerId) continue;
      if (!field.optional) {
        throw new HttpError(409, "Value already exists", { details: [{ field: field.name, message: "Value already exists" }] });
      }
      await touch(model, holder, { [field.name]: null });
    }
  }
}

type ConditionList = Parameters<DatabaseAdapter["findMany"]>[1]["where"];
type OneCondition = ConditionList[number];

function sizeMatches(length: number, filter: { compare: string; count: number }): boolean {
  switch (filter.compare) {
    case "eq":
      return length === filter.count;
    case "ne":
      return length !== filter.count;
    case "gt":
      return length > filter.count;
    case "gte":
      return length >= filter.count;
    case "lt":
      return length < filter.count;
    default:
      return length <= filter.count;
  }
}

/** Every (owner id → related ids) pair of a derived field, read from the side that stores the relation. */
async function derivedPairs(model: EntityModel, field: Derived, models: EntityModel[], adapter: DatabaseAdapter) {
  const pairs = new Map<string, string[]>();
  const add = (owner: unknown, related: unknown) => {
    if (typeof owner !== "string" || typeof related !== "string") return;
    pairs.set(owner, [...(pairs.get(owner) ?? []), related]);
  };
  if (field.relation.kind === "N-N") {
    const { link, side } = linkFor(model, field, models);
    for (const row of await all(adapter, link, [], [{ field: "id", direction: "asc" }])) add(row[side], row[other(side)]);
  } else {
    const target = byKey(models, field.relation.inverseEntity)!;
    const inverse = field.relation.inverseField;
    for (const row of await all(adapter, target, [{ field: inverse, op: "isNull", value: false }], [{ field: "id", direction: "asc" }])) {
      add(row[inverse], row.id);
    }
  }
  return pairs;
}

/** Rewrites one condition on a derived field as a condition on `id`. */
async function resolveCondition(model: EntityModel, field: Derived, condition: OneCondition, models: EntityModel[], adapter: DatabaseAdapter): Promise<OneCondition> {
  const pairs = await derivedPairs(model, field, models, adapter);
  const owners = (test: (related: string[]) => boolean) => [...pairs].filter(([, related]) => test(related)).map(([owner]) => owner);
  const linked = [...pairs.keys()];
  const ids = (value: unknown) => (Array.isArray(value) ? (value as string[]) : [value as string]);
  const inIds = (value: string[]): OneCondition => ({ field: "id", op: "in", value });
  const notInIds = (value: string[]): OneCondition => ({ field: "id", op: "nin", value });
  const { op, value } = condition;
  switch (op) {
    case "contains":
    case "eq":
      return inIds(owners((related) => related.includes(value as string)));
    case "containsAny":
    case "in":
      return inIds(owners((related) => ids(value).some((id) => related.includes(id))));
    case "containsAll":
      return inIds(owners((related) => ids(value).every((id) => related.includes(id))));
    case "ne":
      return inIds(owners((related) => !related.includes(value as string)));
    case "nin":
      return inIds(owners((related) => !ids(value).some((id) => related.includes(id))));
    case "exists":
      return value ? inIds(linked) : notInIds(linked);
    case "isNull":
      return value ? notInIds(linked) : inIds(linked);
    case "isEmpty":
      return value ? notInIds(linked) : inIds(linked);
    case "size": {
      const filter = value as { compare: string; count: number };
      // Records without links have size 0, so the condition is expressed by exclusion when 0 matches.
      return sizeMatches(0, filter)
        ? notInIds(owners((related) => !sizeMatches(related.length, filter)))
        : inIds(owners((related) => sizeMatches(related.length, filter)));
    }
    default:
      throw new Error(`Operator ${op} is not supported on derived relation fields`);
  }
}

/** Replaces conditions on derived relation fields with equivalent conditions on `id`. */
export async function resolveDerivedConditions(
  model: EntityModel,
  where: ConditionList,
  models: EntityModel[],
  adapter: DatabaseAdapter,
): Promise<ConditionList> {
  const fields = new Map(derivedFields(model).map((field) => [field.name, field]));
  if (fields.size === 0 || !where.some((condition) => fields.has(condition.field))) return where;
  const resolved: ConditionList = [];
  for (const condition of where) {
    const field = fields.get(condition.field);
    resolved.push(field ? await resolveCondition(model, field, condition, models, adapter) : condition);
  }
  return resolved;
}
