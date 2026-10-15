import type { DatabaseAdapter, StoredRecord } from "./adapter.ts";
import { HttpError, type FieldErrorDetail } from "./errors.ts";
import type { EntityModel, FieldModel } from "./model.ts";

type RefField = Extract<FieldModel, { type: "ref" }>;
type RefArrayField = Extract<FieldModel, { type: "refArray" }>;

interface Reference {
  model: EntityModel;
  field: RefField | RefArrayField;
}

const isRef = (field: FieldModel): field is RefField => field.type === "ref";
const isReference = (field: FieldModel): field is RefField | RefArrayField => field.type === "ref" || field.type === "refArray";

export function referencesTo(target: EntityModel, models: EntityModel[]): Reference[] {
  return models.flatMap((model) =>
    model.fields.filter(isReference).filter((field) => field.target === target.key).map((field) => ({ model, field })),
  );
}

async function findReferencing(adapter: DatabaseAdapter, reference: Reference, id: string): Promise<StoredRecord[]> {
  const op = reference.field.type === "refArray" ? ("contains" as const) : ("eq" as const);
  const where = [{ field: reference.field.name, op, value: id }];
  const total = await adapter.count(reference.model, where);
  if (total === 0) return [];
  const { data } = await adapter.findMany(reference.model, {
    where,
    sort: [{ field: "id", direction: "asc" }],
    limit: total,
    offset: 0,
  });
  return data;
}

/** Fails with 400 when a reference field points to a record that does not exist. */
export async function assertReferencesExist(
  model: EntityModel,
  values: Record<string, unknown>,
  models: EntityModel[],
  adapter: DatabaseAdapter,
): Promise<void> {
  const details: FieldErrorDetail[] = [];
  for (const field of model.fields) {
    if (field.type !== "refArray") continue;
    const ids = values[field.name];
    if (!Array.isArray(ids) || ids.length === 0) continue;
    const target = models.find((candidate) => candidate.key === field.target);
    const found = target
      ? new Set(
          (
            await adapter.findMany(target, {
              where: [{ field: "id", op: "in", value: ids }],
              sort: [{ field: "id", direction: "asc" }],
              limit: ids.length,
              offset: 0,
            })
          ).data.map((record) => record.id),
        )
      : new Set<string>();
    ids.forEach((id, index) => {
      if (!found.has(id as string)) details.push({ field: `${field.name}[${index}]`, message: "Referenced record not found" });
    });
  }
  for (const field of model.fields.filter(isRef)) {
    const id = values[field.name];
    if (typeof id !== "string") continue;
    const target = models.find((candidate) => candidate.key === field.target);
    if (!target || !(await adapter.findById(target, id))) {
      details.push({ field: field.name, message: "Referenced record not found" });
    }
  }
  if (details.length > 0) throw new HttpError(400, "Invalid body", { details });
}

interface PlannedRecord {
  model: EntityModel;
  id: string;
}

interface DeletePlan {
  deletions: PlannedRecord[];
  /** Records that keep existing but lose the reference: set to null, or pulled from a reference array. */
  updates: { model: EntityModel; record: StoredRecord; changes: Record<string, unknown> }[];
}

const recordKey = (model: EntityModel, id: string) => `${model.key}\u0000${id}`;

/**
 * Collects every record a delete affects, following `cascade` recursively, and fails with 409 before anything
 * changes when a `restrict` reference would be left dangling.
 */
export async function planDelete(
  model: EntityModel,
  id: string,
  models: EntityModel[],
  adapter: DatabaseAdapter,
): Promise<DeletePlan> {
  const deletions: PlannedRecord[] = [];
  const scheduled = new Set<string>();

  const collect = async (current: EntityModel, currentId: string): Promise<void> => {
    const key = recordKey(current, currentId);
    if (scheduled.has(key)) return;
    scheduled.add(key);
    deletions.push({ model: current, id: currentId });
    for (const reference of referencesTo(current, models)) {
      if (reference.field.onDelete !== "cascade") continue;
      for (const record of await findReferencing(adapter, reference, currentId)) {
        await collect(reference.model, record.id);
      }
    }
  };
  await collect(model, id);

  const updates = new Map<string, DeletePlan["updates"][number]>();
  const deletedIds = new Set(deletions.map((deletion) => recordKey(deletion.model, deletion.id)));
  for (const deletion of deletions) {
    for (const reference of referencesTo(deletion.model, models)) {
      for (const record of await findReferencing(adapter, reference, deletion.id)) {
        const key = recordKey(reference.model, record.id);
        if (scheduled.has(key)) continue;
        if (reference.field.onDelete === "restrict") {
          throw new HttpError(409, `Cannot delete: referenced by ${reference.model.name}`);
        }
        const update = updates.get(key) ?? { model: reference.model, record, changes: {} };
        if (reference.field.onDelete === "setNull") update.changes[reference.field.name] = null;
        if (reference.field.onDelete === "pull") {
          const current = (update.changes[reference.field.name] ?? record[reference.field.name] ?? []) as string[];
          update.changes[reference.field.name] = current.filter((id) => !deletedIds.has(recordKey(deletion.model, id)));
        }
        updates.set(key, update);
      }
    }
  }
  return { deletions, updates: [...updates.values()] };
}

export async function executeDeletePlan(
  plan: DeletePlan,
  adapter: DatabaseAdapter,
  nextTimestamp: (previous: Date) => Date,
): Promise<void> {
  await adapter.transaction(async () => {
    for (const { model, record, changes } of plan.updates) {
      await adapter.updateById(model, record.id, { ...changes, updatedAt: nextTimestamp(record.updatedAt) });
    }
    // Dependents were collected after the records they reference, so deleting in reverse keeps foreign keys valid.
    for (const { model, id } of [...plan.deletions].reverse()) {
      await adapter.deleteById(model, id);
    }
  });
}
