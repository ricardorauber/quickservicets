import type { EntityModel, FieldModel, RelationKind } from "@quickservice/core";
import { EntityParseError } from "./errors.ts";

type ReferenceField = Extract<FieldModel, { type: "ref" | "refArray" }>;

interface Side {
  model: EntityModel;
  field: ReferenceField;
}

const isReference = (field: FieldModel): field is ReferenceField => field.type === "ref" || field.type === "refArray";
const fileOf = (model: EntityModel) => `entities/${model.key}.ts`;
const label = (side: Side) => `${side.model.entityName}.${side.field.name}`;

function kindOf(a: ReferenceField, b: ReferenceField): RelationKind {
  if (a.type === "ref" && b.type === "ref") return "1-1";
  if (a.type === "refArray" && b.type === "refArray") return "N-N";
  return "1-N";
}

/** Which side stores the relation; the other one is derived. */
function storingSide(a: Side, b: Side, kind: RelationKind): Side {
  if (kind === "1-N") return a.field.type === "ref" ? a : b;
  if (kind === "1-1") {
    if (a.field.owner && b.field.owner) {
      throw new EntityParseError(`${fileOf(a.model)}: ${label(a)} and ${label(b)} cannot both be @owner`);
    }
    if (a.field.owner) return a;
    if (b.field.owner) return b;
  }
  const byName = (side: Side) => `${side.model.entityName}\u0000${side.field.name}`;
  return byName(a) <= byName(b) ? a : b;
}

function pair(a: Side, b: Side): void {
  const kind = kindOf(a.field, b.field);
  if (kind !== "1-1" && (a.field.owner || b.field.owner)) {
    const side = a.field.owner ? a : b;
    throw new EntityParseError(`${fileOf(side.model)}: invalid @owner on ${label(side)}: only 1-1 relations have an owner`);
  }
  const storing = storingSide(a, b, kind);
  for (const [self, other] of [
    [a, b],
    [b, a],
  ] as const) {
    self.field.relation = { kind, inverseEntity: other.model.key, inverseField: other.field.name, storing: self === storing };
  }
}

/** Pairs reference fields of two entities that point to each other into bidirectional relations. */
export function pairRelations(models: EntityModel[]): void {
  const sides: Side[] = models.flatMap((model) => model.fields.filter(isReference).map((field) => ({ model, field })));
  const paired = new Set<ReferenceField>();
  const find = (entityKey: string, fieldName: string) =>
    sides.find((side) => side.model.key === entityKey && side.field.name === fieldName);

  for (const side of sides) {
    const inverse = side.field.inverse;
    if (!inverse || inverse === "none" || paired.has(side.field)) continue;
    if (side.field.target === side.model.key && inverse === side.field.name) {
      throw new EntityParseError(`${fileOf(side.model)}: ${label(side)} cannot be its own @inverse`);
    }
    const other = find(side.field.target, inverse);
    if (!other || other.field.target !== side.model.key) {
      throw new EntityParseError(
        `${fileOf(side.model)}: @inverse ${inverse} on ${label(side)} must name a reference field of the target pointing back`,
      );
    }
    if (other.field.inverse && other.field.inverse !== side.field.name) {
      throw new EntityParseError(
        `${fileOf(side.model)}: ${label(side)} and ${label(other)} name different inverses (@inverse ${inverse} and @inverse ${other.field.inverse})`,
      );
    }
    pair(side, other);
    paired.add(side.field);
    paired.add(other.field);
  }

  const open = (from: EntityModel, to: EntityModel) =>
    sides.filter(
      (side) =>
        side.model === from &&
        side.field.target === to.key &&
        !paired.has(side.field) &&
        side.field.inverse !== "none",
    );
  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) {
      const x = models[i]!;
      const y = models[j]!;
      const forward = open(x, y);
      const backward = open(y, x);
      if (forward.length === 0 || backward.length === 0) continue;
      if (forward.length === 1 && backward.length === 1) {
        pair(forward[0]!, backward[0]!);
        continue;
      }
      throw new EntityParseError(
        `${fileOf(x)}: ambiguous relation between ${[...forward, ...backward].map(label).join(", ")}; add @inverse to pair them (or @inverse none)`,
      );
    }
  }
}
