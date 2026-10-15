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

export const CRUD_OPERATIONS = ["list", "read", "create", "update", "replace", "delete"] as const;
export type CrudOperation = (typeof CRUD_OPERATIONS)[number];

export interface HookReference {
  name: string;
  operations: CrudOperation[];
  args: string[];
}

export type OverrideHooksMode = "inherit" | "replace";

export interface EntityModel {
  /** Path of the entity file inside `/entities`, without extension (e.g. `Organization`). */
  key: string;
  entityName: string;
  /** Explicit database schema, or null for the default schema. */
  schema: string | null;
  /** camelCase of the explicit schema, used to nest the repository. */
  schemaKey?: string;
  name: string;
  repoKey: string;
  tableName: string;
  fields: FieldModel[];
  hooks: HookReference[];
  overrideHooks: OverrideHooksMode;
  internal: boolean;
}

export const SYSTEM_FIELDS = ["id", "createdAt", "updatedAt"] as const;

/** Base route path of an entity's CRUD routes, e.g. `/users` or `/auth/users`. */
export function entityRoutePath(model: Pick<EntityModel, "schema" | "name">): string {
  return model.schema ? `/${model.schema}/${model.name}` : `/${model.name}`;
}
