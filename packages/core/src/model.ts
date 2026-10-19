export type PrimitiveFieldType = "string" | "number" | "boolean" | "date";

export type OnDeleteAction = "restrict" | "cascade" | "setNull";
export type ArrayOnDeleteAction = "pull" | "restrict" | "cascade";

/**
 * The named `enum` or union type alias an enum field uses, with its file relative to the project root.
 * `implicit` marks an enum without initializers, whose member names are its values.
 */
export interface EnumDeclarationInfo {
  name: string;
  file: string;
  implicit?: true;
}

export type TypeDescriptor =
  | { type: PrimitiveFieldType }
  | { type: "ref"; target: string; onDelete: OnDeleteAction }
  | { type: "refArray"; target: string; onDelete: ArrayOnDeleteAction }
  | { type: "enum"; values: string[]; declaration?: EnumDeclarationInfo }
  | { type: "array"; items: TypeDescriptor }
  | { type: "object"; fields: NestedFieldModel[] };

export type FieldType = TypeDescriptor["type"];

export type StringFormat = "email" | "url";

/** Read operations whose responses field selection applies to. */
export type ReadOperation = "list" | "read";

export interface FieldConstraints {
  /** Never returned in any response. */
  hidden?: boolean;
  /** Not writable through JSON bodies (`unlessPatch`: writable only by PATCH). */
  readOnly?: "always" | "unlessPatch";
  /** Not returned by these read operations. */
  hiddenOn?: ReadOperation[];
  default?: unknown;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  /** Only whole numbers are accepted (number fields). */
  integer?: boolean;
  format?: StringFormat;
}

export type NestedFieldModel = TypeDescriptor &
  FieldConstraints & {
    name: string;
    optional: boolean;
  };

/**
 * `relation` fields (reference arrays) are stored outside the entity's own columns; `derived` fields are the
 * non-storing side of a bidirectional relation and are computed on read.
 */
export type FieldStorage = "column" | "json" | "relation" | "derived" | "computed";

export type RelationKind = "1-1" | "1-N" | "N-N";

export type FileAccessMode = "direct" | "proxy" | "signed";

/** One side of a bidirectional relation between two reference fields. */
export interface RelationSide {
  kind: RelationKind;
  /** Entity key and field name of the other side. */
  inverseEntity: string;
  inverseField: string;
  /** True on the side that holds the data (foreign key or junction); the other side is derived. */
  storing: boolean;
}

export type FieldModel = NestedFieldModel & {
  storage: FieldStorage;
  unique?: boolean;
  index?: boolean;
  /** `@inverse <field>` or `@inverse none`, as written. */
  inverse?: string;
  /** `@owner`: this side stores a 1-1 relation. */
  owner?: boolean;
  /** `@onConflict replace`: linking a 1-1 target that is already linked moves the link instead of failing. */
  onConflict?: "replace";
  /** `@joinTable <name>`: name of the junction table (or join collection) of a reference array or N-N relation. */
  joinTable?: string;
  /** Set when the field is paired with an inverse field into one relation. */
  relation?: RelationSide;
  /**
   * `@maxSize` (bytes) and `@accept` (MIME patterns) of each file a reference to a file entity takes, on top of the
   * entity's limits, and `@maxTotalSize` (bytes) of the files uploaded to an array in one request.
   */
  fileLimits?: { maxSize?: number; accept?: string[]; maxTotalSize?: number };
  /** `@keepFile`: the referenced file is never removed when replaced or when this record is deleted. */
  keepFile?: boolean;
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
  /**
   * Set on the internal entity that stores an N-N relation: one record per linked pair, with fields `left`,
   * `right`, `leftPosition`, `rightPosition` and `pair`.
   */
  link?: { left: { entity: string; field: string }; right: { entity: string; field: string } };
  /** Set on file entities: built-in `File`/`Media` and entities extending them. */
  file?: { base: "file" | "media" };
  /** `@storage <name>`: the configured storage of a file entity (default: `default`). */
  storageName?: string;
  /** `@maxSize` (bytes) and `@accept` (MIME patterns) of a file entity. */
  fileLimits?: { maxSize?: number; accept?: string[] };
  /** `@access <mode> [ttlSeconds]` of a file entity. */
  fileAccess?: { mode: FileAccessMode; ttl?: number };
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
