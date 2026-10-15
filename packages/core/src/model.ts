export type PrimitiveFieldType = "string" | "number" | "boolean" | "date";

export type OnDeleteAction = "restrict" | "cascade" | "setNull";
export type ArrayOnDeleteAction = "pull" | "restrict" | "cascade";

export type TypeDescriptor =
  | { type: PrimitiveFieldType }
  | { type: "ref"; target: string; onDelete: OnDeleteAction }
  | { type: "refArray"; target: string; onDelete: ArrayOnDeleteAction }
  | { type: "enum"; values: string[] }
  | { type: "array"; items: TypeDescriptor }
  | { type: "object"; fields: NestedFieldModel[] };

export type FieldType = TypeDescriptor["type"];

export type StringFormat = "email" | "url";

/** Read operations whose responses field selection applies to. */
export type ReadOperation = "list" | "read";

export interface FieldConstraints {
  /** Never returned in any response. */
  hidden?: boolean;
  /** Not returned by these read operations. */
  hiddenOn?: ReadOperation[];
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

/** `relation` fields (reference arrays) are stored outside the entity's own columns. */
export type FieldStorage = "column" | "json" | "relation";

export type FieldModel = NestedFieldModel & {
  storage: FieldStorage;
  unique?: boolean;
  index?: boolean;
};

/** The paths a read operation returns: keep `include`, then remove `exclude` (see `project`). */
export interface Exposure {
  include: string[];
  exclude: string[];
}

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
  /** Exposed paths of list and read responses. */
  exposure: Record<ReadOperation, Exposure>;
  /** Reference paths populated by default on list and read (`@populate`). */
  populate?: Partial<Record<ReadOperation, string[]>>;
}

/** Paths of fields (top-level or nested) that are never returned. */
export function alwaysHiddenPaths(fields: NestedFieldModel[], prefix = ""): string[] {
  return fields.flatMap((field) => {
    const path = `${prefix}${field.name}`;
    if (field.hidden) return [path];
    const nested = field.type === "object" ? field.fields : field.type === "array" && field.items.type === "object" ? field.items.fields : undefined;
    return nested ? alwaysHiddenPaths(nested, `${path}.`) : [];
  });
}

/** Paths hidden for one read operation, including the always-hidden ones. */
export function hiddenPathsFor(fields: NestedFieldModel[], operation: ReadOperation, prefix = ""): string[] {
  return fields.flatMap((field) => {
    const path = `${prefix}${field.name}`;
    if (field.hidden || field.hiddenOn?.includes(operation)) return [path];
    const nested = field.type === "object" ? field.fields : field.type === "array" && field.items.type === "object" ? field.items.fields : undefined;
    return nested ? hiddenPathsFor(nested, operation, `${path}.`) : [];
  });
}

export const SYSTEM_FIELDS = ["id", "createdAt", "updatedAt"] as const;

/** Base route path of an entity's CRUD routes, e.g. `/users` or `/auth/users`. */
export function entityRoutePath(model: Pick<EntityModel, "schema" | "name">): string {
  return model.schema ? `/${model.schema}/${model.name}` : `/${model.name}`;
}
