import type { EntityModel } from "@quickservicets/core";

const pascal = (value: string) => value.replace(/(^|[-_])([a-z0-9])/g, (_, __, char: string) => char.toUpperCase()).replace(/^[a-z]/, (char) => char.toUpperCase());

interface Change {
  entity: string;
  name: string;
}

/** Describes the model change from `previous` to `current` as a migration name. */
export function suggestMigrationName(previous: EntityModel[], current: EntityModel[]): string {
  const changes: Change[] = [];
  const byKey = (models: EntityModel[]) => new Map(models.map((model) => [model.key, model]));
  const before = byKey(previous);
  const after = byKey(current);

  for (const [key, model] of after) {
    const old = before.get(key);
    if (!old) {
      changes.push({ entity: key, name: `Create${model.entityName}` });
      continue;
    }
    const collection = pascal(model.name);
    const oldFields = new Map(old.fields.map((field) => [field.name, field]));
    for (const field of model.fields) {
      const previousField = oldFields.get(field.name);
      if (!previousField) changes.push({ entity: key, name: `Add${pascal(field.name)}To${collection}` });
      else if (JSON.stringify(previousField) !== JSON.stringify(field)) {
        changes.push({ entity: key, name: `Alter${pascal(field.name)}In${collection}` });
      }
    }
    for (const field of old.fields) {
      if (!model.fields.some((candidate) => candidate.name === field.name)) {
        changes.push({ entity: key, name: `Remove${pascal(field.name)}From${collection}` });
      }
    }
  }
  for (const [key, model] of before) {
    if (!after.has(key)) changes.push({ entity: key, name: `Drop${model.entityName}` });
  }

  if (changes.length === 1) return changes[0]!.name;
  const entities = new Set(changes.map((change) => change.entity));
  if (entities.size === 1) return `Update${(after.get([...entities][0]!) ?? before.get([...entities][0]!))!.entityName}`;
  return "UpdateModel";
}
