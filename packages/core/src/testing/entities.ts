import type { EntityModel, FieldModel } from "../model.ts";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type FieldInput = DistributiveOmit<FieldModel, "storage" | "optional"> & { optional?: boolean };

export function field(input: FieldInput): FieldModel {
  const storage = input.type === "refArray" ? "relation" : input.type === "array" || input.type === "object" ? "json" : "column";
  return { optional: false, ...input, storage } as FieldModel;
}

export function entity(entityName: string, fields: FieldModel[], overrides: Partial<EntityModel> = {}): EntityModel {
  const name = `${entityName.toLowerCase()}s`;
  return {
    key: entityName,
    entityName,
    schema: null,
    name,
    repoKey: name,
    tableName: name,
    fields,
    hooks: [],
    overrideHooks: "inherit",
    internal: false,
    exposure: {
      list: { include: ["id", "createdAt", "updatedAt", ...fields.map((item) => item.name)], exclude: [] },
      read: { include: ["id", "createdAt", "updatedAt", ...fields.map((item) => item.name)], exclude: [] },
    },
    ...overrides,
  };
}
