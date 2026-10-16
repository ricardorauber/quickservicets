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
