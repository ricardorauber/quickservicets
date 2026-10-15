import type { DatabaseAdapter, StoredRecord } from "./adapter.ts";
import { HttpError, type FieldErrorDetail } from "./errors.ts";
import type { EntityModel, FieldModel } from "./model.ts";

type RefField = Extract<FieldModel, { type: "ref" }>;

interface Reference {
  model: EntityModel;
  field: RefField;
}

const isRef = (field: FieldModel): field is RefField => field.type === "ref";

export function referencesTo(target: EntityModel, models: EntityModel[]): Reference[] {
  return models.flatMap((model) =>
    model.fields.filter(isRef).filter((field) => field.target === target.key).map((field) => ({ model, field })),
  );
}

async function findReferencing(adapter: DatabaseAdapter, reference: Reference, id: string): Promise<StoredRecord[]> {
  const where = [{ field: reference.field.name, op: "eq" as const, value: id }];
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
  nullifications: { model: EntityModel; record: StoredRecord; field: string }[];
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

  const nullifications: DeletePlan["nullifications"] = [];
  for (const deletion of deletions) {
    for (const reference of referencesTo(deletion.model, models)) {
      for (const record of await findReferencing(adapter, reference, deletion.id)) {
        if (scheduled.has(recordKey(reference.model, record.id))) continue;
        if (reference.field.onDelete === "restrict") {
          throw new HttpError(409, `Cannot delete: referenced by ${reference.model.name}`);
        }
        if (reference.field.onDelete === "setNull") {
          nullifications.push({ model: reference.model, record, field: reference.field.name });
        }
      }
    }
  }
  return { deletions, nullifications };
}

export async function executeDeletePlan(
  plan: DeletePlan,
  adapter: DatabaseAdapter,
  nextTimestamp: (previous: Date) => Date,
): Promise<void> {
  await adapter.transaction(async () => {
    for (const { model, record, field } of plan.nullifications) {
      await adapter.updateById(model, record.id, { [field]: null, updatedAt: nextTimestamp(record.updatedAt) });
    }
    // Dependents were collected after the records they reference, so deleting in reverse keeps foreign keys valid.
    for (const { model, id } of [...plan.deletions].reverse()) {
      await adapter.deleteById(model, id);
    }
  });
}
