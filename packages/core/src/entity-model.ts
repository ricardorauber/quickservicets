import {
  hiddenPathsFor,
  SYSTEM_FIELDS,
  type ArrayOnDeleteAction,
  type EntityModel,
  type FieldConstraints,
  type FieldModel,
  type HookReference,
  type ModelIndex,
  type NestedFieldModel,
  type OnDeleteAction,
  type OverrideHooksMode,
  type ReadOperation,
  type TypeDescriptor,
} from "./model.ts";
import { deriveCollectionName, toCamelCase, toSnakeCase } from "./naming.ts";

type Descriptor<T> = T extends { type: "ref" }
  ? { type: "ref"; target: string; onDelete?: OnDeleteAction }
  : T extends { type: "refArray" }
    ? { type: "refArray"; target: string; onDelete?: ArrayOnDeleteAction }
    : T;

/** What `field` accepts: a field type with its constraints, without a name (the key in `entityModel` names it). */
export type FieldInput = Descriptor<TypeDescriptor> &
  FieldConstraints & {
    /** May be absent or null (default false). */
    optional?: boolean;
    unique?: boolean;
    index?: boolean;
    joinTable?: string;
  };

/** A field built by `field`, named by its key in `entityModel`. */
export type FieldDefinition = Omit<FieldModel, "name">;

/** Builds a field of an `EntityModel`; references default to `restrict` and reference arrays to `pull` on delete. */
export function field(definition: FieldInput): FieldDefinition {
  const input = { ...definition } as FieldInput & { onDelete?: string };
  if (input.type === "ref") input.onDelete ??= "restrict";
  if (input.type === "refArray") input.onDelete ??= "pull";
  const storage = input.type === "refArray" ? "relation" : input.type === "array" || input.type === "object" || input.type === "json" ? "json" : "column";
  return { ...input, optional: input.optional ?? false, storage } as FieldDefinition;
}

/** What `entityModel` accepts besides the name and fields. */
export interface EntityModelOptions {
  /** Name of the table or collection and of the routes (default: the plural of the name in kebab-case). */
  collection?: string;
  /** Database schema (default: the default schema). */
  schema?: string | null;
  /** No routes; used only from code (default false). */
  internal?: boolean;
  hooks?: HookReference[];
  overrideHooks?: OverrideHooksMode;
  populate?: Partial<Record<ReadOperation, string[]>>;
  indexes?: ModelIndex[];
  /** `shared` keeps the entity's records shared by every tenant when the `tenancy` native is enabled. */
  tenancy?: "tenant" | "shared";
  /** The key of the entity this model is derived from, whose tenancy it follows. */
  derivedFrom?: string;
}

/** Builds an `EntityModel` from code, with the same names and exposure the build gives a parsed entity file. */
export function entityModel(name: string, fields: Record<string, FieldDefinition>, options: EntityModelOptions = {}): EntityModel {
  const collection = options.collection ?? deriveCollectionName(name);
  const schema = options.schema ?? null;
  const fieldModels = Object.entries(fields).map(([fieldName, definition]) => ({ ...definition, name: fieldName }) as FieldModel);
  const exposure = (operation: ReadOperation) => ({
    include: [...SYSTEM_FIELDS, ...fieldModels.map((item) => item.name)],
    exclude: hiddenPathsFor(fieldModels as NestedFieldModel[], operation),
  });
  return {
    key: name,
    entityName: name,
    schema,
    ...(schema ? { schemaKey: toCamelCase(schema) } : {}),
    name: collection,
    repoKey: toCamelCase(collection),
    tableName: toSnakeCase(collection),
    fields: fieldModels,
    hooks: options.hooks ?? [],
    overrideHooks: options.overrideHooks ?? "inherit",
    internal: options.internal ?? false,
    ...(options.populate ? { populate: options.populate } : {}),
    ...(options.indexes ? { indexes: options.indexes } : {}),
    ...(options.tenancy ? { tenancy: options.tenancy } : {}),
    ...(options.derivedFrom ? { derivedFrom: options.derivedFrom } : {}),
    exposure: { list: exposure("list"), read: exposure("read") },
  };
}
