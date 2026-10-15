import { SYSTEM_FIELDS, type EntityModel, type NestedFieldModel, type TypeDescriptor } from "./model.ts";

export type FieldPathsResult = { ok: true; paths: string[] } | { ok: false; invalid: string[] };

function nestedFieldsOf(descriptor: TypeDescriptor): NestedFieldModel[] | undefined {
  if (descriptor.type === "object") return descriptor.fields;
  if (descriptor.type === "array" && descriptor.items.type === "object") return descriptor.items.fields;
  return undefined;
}

function resolves(model: EntityModel, path: string): boolean {
  const segments = path.split(".");
  if (segments.some((segment) => segment === "")) return false;
  const [first, ...rest] = segments;
  if ((SYSTEM_FIELDS as readonly string[]).includes(first!)) return rest.length === 0;
  let current: TypeDescriptor | undefined = model.fields.find((field) => field.name === first);
  for (const segment of rest) {
    const nested = current ? nestedFieldsOf(current) : undefined;
    current = nested?.find((field) => field.name === segment);
  }
  return current !== undefined;
}

/** Parses and validates dot-separated field paths against an entity model. */
export function parseFieldPaths(model: EntityModel, input: string | string[]): FieldPathsResult {
  const entries = (Array.isArray(input) ? input : input.split(",")).map((entry) => entry.trim());
  const paths = [...new Set(entries)];
  const invalid = paths.filter((path) => path === "" || !resolves(model, path));
  return invalid.length > 0 ? { ok: false, invalid } : { ok: true, paths };
}

type PathTree = Map<string, PathTree | true>;

function toTree(paths: string[]): PathTree {
  const root: PathTree = new Map();
  for (const path of paths) {
    let node = root;
    const segments = path.split(".");
    segments.forEach((segment, index) => {
      const existing = node.get(segment);
      if (existing === true) return;
      if (index === segments.length - 1) {
        node.set(segment, true);
        return;
      }
      const child: PathTree = existing ?? new Map();
      node.set(segment, child);
      node = child;
    });
  }
  return root;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);

function keep(value: unknown, tree: PathTree): unknown {
  if (Array.isArray(value)) return value.map((item) => keep(item, tree));
  if (!isObject(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, subtree] of tree) {
    if (!(key in value)) continue;
    result[key] = subtree === true ? value[key] : keep(value[key], subtree);
  }
  return result;
}

function remove(value: unknown, tree: PathTree): unknown {
  if (Array.isArray(value)) return value.map((item) => remove(item, tree));
  if (!isObject(value)) return value;
  const result: Record<string, unknown> = { ...value };
  for (const [key, subtree] of tree) {
    if (!(key in result)) continue;
    if (subtree === true) delete result[key];
    else result[key] = remove(result[key], subtree);
  }
  return result;
}

export interface Projection {
  include?: string[];
  exclude?: string[];
}

/** Keeps the `include` paths (whole subtrees), then removes the `exclude` paths. Never mutates its input. */
export function project(value: unknown, { include, exclude }: Projection): unknown {
  let result: unknown = structuredClone(value);
  if (include) result = keep(result, toTree(include));
  if (exclude) result = remove(result, toTree(exclude));
  return result;
}
