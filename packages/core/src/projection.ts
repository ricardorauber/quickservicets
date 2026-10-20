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

/** Path trees by the path list they were built from: exposures are built once, so their trees are too. */
const trees = new WeakMap<readonly string[], PathTree>();

function treeOf(paths: string[]): PathTree {
  let tree = trees.get(paths);
  if (!tree) {
    tree = toTree(paths);
    trees.set(paths, tree);
  }
  return tree;
}

/** Maps every item, returning the array itself when no item changed. */
function mapItems(items: unknown[], fn: (item: unknown) => unknown): unknown[] {
  let result: unknown[] | undefined;
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const mapped = fn(item);
    if (!result && mapped !== item) result = items.slice(0, index);
    if (result) result.push(mapped);
  }
  return result ?? items;
}

/**
 * Keeps the tree's paths, in the tree's order. Returns the value itself when it would come back unchanged: it has
 * exactly the kept keys, already in that order, and every kept subtree is unchanged.
 */
function keep(value: unknown, tree: PathTree): unknown {
  if (Array.isArray(value)) return mapItems(value, (item) => keep(item, tree));
  if (!isObject(value)) return value;
  const keys = Object.keys(value);
  let result: Record<string, unknown> | undefined;
  let index = 0;
  for (const [key, subtree] of tree) {
    if (!Object.hasOwn(value, key)) continue;
    const original = value[key];
    const kept = subtree === true ? original : keep(original, subtree);
    if (!result && (kept !== original || keys[index] !== key)) {
      result = {};
      for (let previous = 0; previous < index; previous++) result[keys[previous]!] = value[keys[previous]!];
    }
    if (result) result[key] = kept;
    index++;
  }
  if (result) return result;
  if (index === keys.length) return value;
  const trimmed: Record<string, unknown> = {};
  for (let previous = 0; previous < index; previous++) trimmed[keys[previous]!] = value[keys[previous]!];
  return trimmed;
}

/** Removes the tree's paths, copying only the objects along a path that actually changes. */
function remove(value: unknown, tree: PathTree): unknown {
  if (Array.isArray(value)) return mapItems(value, (item) => remove(item, tree));
  if (!isObject(value)) return value;
  let result: Record<string, unknown> | undefined;
  for (const [key, subtree] of tree) {
    if (!Object.hasOwn(value, key)) continue;
    if (subtree === true) {
      result ??= { ...value };
      delete result[key];
      continue;
    }
    const original = value[key];
    const removed = remove(original, subtree);
    if (removed === original) continue;
    result ??= { ...value };
    result[key] = removed;
  }
  return result ?? value;
}

export interface Projection {
  include?: string[];
  exclude?: string[];
}

/**
 * Keeps the `include` paths (whole subtrees), then removes the `exclude` paths. Never mutates its input and never
 * deep-copies it: new objects are built only along the paths that change, everything else is shared with the input,
 * and the input itself comes back when nothing changes.
 */
export function project(value: unknown, { include, exclude }: Projection): unknown {
  let result = value;
  if (include) result = keep(result, treeOf(include));
  if (exclude) result = remove(result, treeOf(exclude));
  return result;
}

/**
 * Projects an endpoint result: each item of `data` for `{ data: [...] }` results, each item of arrays, or the
 * value itself. `Response` and `undefined` results are left untouched.
 */
export function projectResult(result: unknown, projection: Projection): unknown {
  if (result === undefined || result instanceof Response) return result;
  if (Array.isArray(result)) return result.map((item) => project(item, projection));
  if (typeof result === "object" && result !== null && Array.isArray((result as { data?: unknown }).data)) {
    const container = result as { data: unknown[] };
    return { ...container, data: container.data.map((item) => project(item, projection)) };
  }
  return project(result, projection);
}
