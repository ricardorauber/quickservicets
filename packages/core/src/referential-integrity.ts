import { findAll, type DatabaseAdapter, type ReferencePull, type StoredRecord } from "./adapter.ts";
import { runInTransaction } from "./transactions.ts";
import { HttpError, type FieldErrorDetail } from "./errors.ts";
import type { EntityModel, FieldModel } from "./model.ts";
import { itemCount } from "./validation.ts";

type RefField = Extract<FieldModel, { type: "ref" }>;
type RefArrayField = Extract<FieldModel, { type: "refArray" }>;

interface Reference {
  model: EntityModel;
  field: RefField | RefArrayField;
}

const isRef = (field: FieldModel): field is RefField => field.type === "ref";
const isReference = (field: FieldModel): field is RefField | RefArrayField => field.type === "ref" || field.type === "refArray";

/** Stored references to `target`: derived relation sides and link entities are planned separately. */
export function referencesTo(target: EntityModel, models: EntityModel[]): Reference[] {
  return models
    .filter((model) => !model.link)
    .flatMap((model) =>
      model.fields
        .filter(isReference)
        .filter((field) => field.target === target.key && field.storage !== "derived")
        .map((field) => ({ model, field })),
    );
}

/** Every record whose `reference` field points to `id`. */
function findReferencing(adapter: DatabaseAdapter, reference: Reference, id: string): Promise<StoredRecord[]> {
  const op = reference.field.type === "refArray" ? ("contains" as const) : ("eq" as const);
  return findAll(adapter, reference.model, [{ field: reference.field.name, op, value: id }], [{ field: "id", direction: "asc" }]);
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
              withTotal: false,
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

interface PlannedDeletion extends PlannedRecord {
  /** Reference arrays the adapter removes the id from as part of the delete (see `DatabaseAdapter.deleteAndPull`). */
  pulls: ReferencePull[];
}

interface DeletePlan {
  deletions: PlannedDeletion[];
  /**
   * Records that keep existing but lose the reference: set to null, pulled from a reference array, or unlinked from
   * an N-N relation (no change besides `updatedAt`).
   */
  updates: { model: EntityModel; record: StoredRecord; changes: Record<string, unknown> }[];
}

const recordKey = (model: EntityModel, id: string) => `${model.key}\u0000${id}`;

/** Links of N-N relations with `current` on one side: the side, the other entity and its field pointing to `current`. */
function linksOf(current: EntityModel, models: EntityModel[]) {
  return models.flatMap((link) =>
    !link.link
      ? []
      : (["left", "right"] as const)
          .filter((side) => link.link![side].entity === current.key)
          .map((side) => {
            const otherSide = side === "left" ? "right" : "left";
            const owner = models.find((candidate) => candidate.key === link.link![otherSide].entity)!;
            const pointing = owner.fields.find((field) => field.name === link.link![otherSide].field) as RefArrayField;
            return { link, side, otherSide, owner, pointing };
          }),
  );
}

/** Derived 1-1/1-N sides of other entities whose records point to a `current` record. */
function derivedSidesTo(current: EntityModel, models: EntityModel[]) {
  return models.flatMap((owner) =>
    owner.fields
      .filter(isReference)
      .filter(
        (field) =>
          field.storage === "derived" &&
          field.relation !== undefined &&
          field.relation.kind !== "N-N" &&
          field.relation.inverseEntity === current.key &&
          field.target === current.key,
      )
      .map((field) => ({ owner, field })),
  );
}

/** Every entity a delete of `model` can remove, following `cascade` rules (including N-N links). */
export function cascadedEntities(model: EntityModel, models: EntityModel[]): EntityModel[] {
  const found = new Set<EntityModel>([model]);
  const queue = [model];
  const add = (entity: EntityModel) => {
    if (found.has(entity)) return;
    found.add(entity);
    queue.push(entity);
  };
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const reference of referencesTo(current, models)) if (reference.field.onDelete === "cascade") add(reference.model);
    for (const { link, owner, pointing } of linksOf(current, models)) {
      add(link);
      if (pointing.onDelete === "cascade") add(owner);
    }
    for (const { owner, field } of derivedSidesTo(current, models)) if (field.onDelete === "cascade") add(owner);
  }
  return [...found];
}

/** Reference arrays an adapter can pull ids from in place: junction-stored ones with `@onDelete pull`. */
const pullsInPlace = (adapter: DatabaseAdapter, field: RefField | RefArrayField) =>
  adapter.deleteAndPull !== undefined && field.type === "refArray" && field.onDelete === "pull";

/**
 * Collects every record a delete affects, following `cascade` recursively, and fails with 409 before anything
 * changes when a `restrict` reference would be left dangling or a pull would leave a reference array below its
 * `@minItems`. `record` is the deleted record when the caller already read it.
 */
export async function planDelete(
  model: EntityModel,
  id: string,
  models: EntityModel[],
  adapter: DatabaseAdapter,
  record?: StoredRecord,
): Promise<DeletePlan> {
  const deletions: PlannedDeletion[] = [];
  const scheduled = new Set<string>();
  const known = new Map<string, StoredRecord | null>(record ? [[recordKey(model, id), record]] : []);
  const read = async (current: EntityModel, currentId: string) => {
    const key = recordKey(current, currentId);
    if (!known.has(key)) known.set(key, await adapter.findById(current, currentId));
    return known.get(key)!;
  };

  const restrictions: { name: string; key: string }[] = [];
  /** Records on the other side of N-N relations whose links the delete removes. */
  const unlinked: PlannedRecord[] = [];
  const collect = async (current: EntityModel, currentId: string): Promise<void> => {
    const key = recordKey(current, currentId);
    if (scheduled.has(key)) return;
    scheduled.add(key);
    deletions.push({ model: current, id: currentId, pulls: [] });
    for (const reference of referencesTo(current, models)) {
      if (reference.field.onDelete !== "cascade") continue;
      for (const found of await findReferencing(adapter, reference, currentId)) {
        await collect(reference.model, found.id);
      }
    }
    // N-N links: the rule of the field pointing to the deleted record decides; links always go away.
    for (const { link, side, otherSide, owner, pointing } of linksOf(current, models)) {
      const rows = await findReferencing(adapter, { model: link, field: link.fields.find((field) => field.name === side) as RefField }, currentId);
      for (const row of rows) {
        deletions.push({ model: link, id: row.id, pulls: [] });
        const ownerId = row[otherSide] as string;
        unlinked.push({ model: owner, id: ownerId });
        if (pointing.onDelete === "restrict") restrictions.push({ name: owner.name, key: recordKey(owner, ownerId) });
        if (pointing.onDelete === "cascade") await collect(owner, ownerId);
      }
    }
    // Derived 1-1/1-N sides pointing to the deleted record: their own rule applies.
    for (const { owner, field } of derivedSidesTo(current, models)) {
      const ownerId = (await read(current, currentId))?.[field.relation!.inverseField];
      if (typeof ownerId !== "string") continue;
      if (field.onDelete === "restrict") restrictions.push({ name: owner.name, key: recordKey(owner, ownerId) });
      if (field.onDelete === "cascade") await collect(owner, ownerId);
    }
  };
  await collect(model, id);
  const blocking = restrictions.find((restriction) => !scheduled.has(restriction.key));
  if (blocking) throw new HttpError(409, `Cannot delete: referenced by ${blocking.name}`);

  const updates = new Map<string, DeletePlan["updates"][number]>();
  const deletedIds = new Set(deletions.map((deletion) => recordKey(deletion.model, deletion.id)));
  for (const deletion of deletions) {
    for (const reference of referencesTo(deletion.model, models)) {
      if (pullsInPlace(adapter, reference.field)) {
        deletion.pulls.push({ owner: reference.model, field: reference.field.name });
        // The owners' lists are only needed to check a minimum before anything changes.
        if (reference.field.minLength === undefined) continue;
      }
      for (const found of await findReferencing(adapter, reference, deletion.id)) {
        const key = recordKey(reference.model, found.id);
        if (scheduled.has(key)) continue;
        if (reference.field.onDelete === "restrict") {
          throw new HttpError(409, `Cannot delete: referenced by ${reference.model.name}`);
        }
        const update = updates.get(key) ?? { model: reference.model, record: found, changes: {} };
        if (reference.field.onDelete === "setNull") update.changes[reference.field.name] = null;
        if (reference.field.onDelete === "pull") {
          const current = (update.changes[reference.field.name] ?? found[reference.field.name] ?? []) as string[];
          update.changes[reference.field.name] = current.filter((id) => !deletedIds.has(recordKey(deletion.model, id)));
        }
        updates.set(key, update);
      }
    }
  }
  // Records that lost an N-N link only get a new `updatedAt`.
  for (const { model: owner, id: ownerId } of unlinked) {
    const key = recordKey(owner, ownerId);
    if (scheduled.has(key) || updates.has(key)) continue;
    const found = await read(owner, ownerId);
    if (found) updates.set(key, { model: owner, record: found, changes: {} });
  }
  for (const { model: owner, changes } of updates.values()) {
    for (const field of owner.fields) {
      if (field.type !== "refArray" || field.onDelete !== "pull" || field.minLength === undefined) continue;
      const list = changes[field.name];
      if (Array.isArray(list) && list.length < field.minLength) {
        throw new HttpError(409, `Cannot delete: ${owner.name}.${field.name} would have fewer than ${itemCount(field.minLength)}`);
      }
    }
  }
  // Lists checked above are pulled by the deletes themselves, which also refresh their owners' `updatedAt`.
  const remaining = [...updates.values()].flatMap((update) => {
    const pulled = update.model.fields.filter((field) => field.name in update.changes && isReference(field) && pullsInPlace(adapter, field));
    if (pulled.length === 0) return [update];
    const changes = Object.fromEntries(Object.entries(update.changes).filter(([name]) => !pulled.some((field) => field.name === name)));
    return Object.keys(changes).length > 0 ? [{ ...update, changes }] : [];
  });
  return { deletions, updates: remaining };
}

export async function executeDeletePlan(
  plan: DeletePlan,
  adapter: DatabaseAdapter,
  nextTimestamp: (previous?: Date) => Date,
): Promise<void> {
  const run = async () => {
    for (const { model, record, changes } of plan.updates) {
      await adapter.updateById(model, record.id, { ...changes, updatedAt: nextTimestamp(record.updatedAt) });
    }
    // Dependents were collected after the records they reference, so deleting in reverse keeps foreign keys valid.
    for (const { model, id, pulls } of [...plan.deletions].reverse()) {
      if (pulls.length > 0) await adapter.deleteAndPull!(model, id, pulls, nextTimestamp());
      else await adapter.deleteById(model, id);
    }
  };
  // A single write is atomic on its own.
  await (plan.updates.length + plan.deletions.length === 1 ? run() : runInTransaction(adapter, run));
}
