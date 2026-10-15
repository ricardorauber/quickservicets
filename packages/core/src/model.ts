export type PrimitiveFieldType = "string" | "number" | "boolean" | "date";

export type OnDeleteAction = "restrict" | "cascade" | "setNull";

export type TypeDescriptor =
  | { type: PrimitiveFieldType }
  | { type: "ref"; target: string; onDelete: OnDeleteAction }
  | { type: "enum"; values: string[] }
  | { type: "array"; items: TypeDescriptor }
  | { type: "object"; fields: NestedFieldModel[] };

export type FieldType = TypeDescriptor["type"];

export type StringFormat = "email" | "url";

export interface FieldConstraints {
  default?: unknown;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  format?: StringFormat;
}

export type NestedFieldModel = TypeDescriptor &
  FieldConstraints & {
    name: string;
    optional: boolean;
  };

export type FieldStorage = "column" | "json";

export type FieldModel = NestedFieldModel & {
  storage: FieldStorage;
  unique?: boolean;
  index?: boolean;
  hidden?: boolean;
};

export interface EntityModel {
  /** Path of the entity file inside `/entities`, without extension (e.g. `Organization`). */
  key: string;
  entityName: string;
  name: string;
  repoKey: string;
  tableName: string;
  fields: FieldModel[];
}

export const SYSTEM_FIELDS = ["id", "createdAt", "updatedAt"] as const;
