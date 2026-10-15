export type PrimitiveFieldType = "string" | "number" | "boolean" | "date";

export interface FieldModel {
  name: string;
  type: PrimitiveFieldType;
  optional: boolean;
}

export interface EntityModel {
  entityName: string;
  name: string;
  repoKey: string;
  tableName: string;
  fields: FieldModel[];
}

export const SYSTEM_FIELDS = ["id", "createdAt", "updatedAt"] as const;
