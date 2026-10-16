import type { FieldErrorDetail } from "./errors.ts";
import { SYSTEM_FIELDS, type EntityModel, type FieldConstraints, type NestedFieldModel, type TypeDescriptor } from "./model.ts";

type ValueSpec = TypeDescriptor & FieldConstraints;

export type ValidationMode = "create" | "replace" | "patch";

/** A PATCH of a reference array given as ids to add and remove, resolved against the stored list. */
export class ReferenceArrayChange {
  constructor(
    readonly add: string[],
    readonly remove: string[],
  ) {}

  /** Removes first, keeps present ids in place, and appends new ids in the order sent. */
  applyTo(current: string[]): string[] {
    const removed = current.filter((id) => !this.remove.includes(id));
    return [...removed, ...this.add.filter((id) => !removed.includes(id))];
  }
}

export type ValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; details: FieldErrorDetail[] };

const ISO_8601 = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

class Collector {
  readonly details: FieldErrorDetail[] = [];
  add(field: string, message: string): void {
    this.details.push({ field, message });
  }
}

const joinPath = (prefix: string, name: string) => (prefix ? `${prefix}.${name}` : name);

function validateIdList(raw: unknown[], path: string, errors: Collector): string[] | undefined {
  const seen = new Set<string>();
  let valid = true;
  raw.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (typeof item !== "string" || item === "") {
      valid = false;
      errors.add(itemPath, "Must be a string");
    } else if (seen.has(item)) {
      valid = false;
      errors.add(itemPath, "Duplicate item");
    } else {
      seen.add(item);
    }
  });
  return valid ? [...(raw as string[])] : undefined;
}

function validateChange(raw: Record<string, unknown>, path: string, errors: Collector): ReferenceArrayChange | undefined {
  const before = errors.details.length;
  for (const key of Object.keys(raw)) {
    if (key !== "add" && key !== "remove") errors.add(`${path}.${key}`, "Unknown field");
  }
  const lists: Record<"add" | "remove", string[]> = { add: [], remove: [] };
  for (const key of ["add", "remove"] as const) {
    if (raw[key] === undefined) continue;
    if (!Array.isArray(raw[key])) {
      errors.add(`${path}.${key}`, "Must be an array");
      continue;
    }
    lists[key] = validateIdList(raw[key], `${path}.${key}`, errors) ?? [];
  }
  if (lists.add.some((id) => lists.remove.includes(id))) errors.add(path, "Conflicting operations");
  return errors.details.length > before ? undefined : new ReferenceArrayChange(lists.add, lists.remove);
}

function validateFields(
  fields: NestedFieldModel[],
  input: Record<string, unknown>,
  prefix: string,
  requireAll: "create" | "replace" | "none",
  errors: Collector,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const field of fields) {
    const path = joinPath(prefix, field.name);
    if (field.readOnly && (field.readOnly === "always" || requireAll !== "none")) {
      // Set by the framework (e.g. uploads), never required from or written by a JSON body.
      if (field.name in input) errors.add(path, "Field is read-only");
      continue;
    }
    if (!(field.name in input) || input[field.name] === undefined) {
      const required = !field.optional && (requireAll === "replace" || (requireAll === "create" && field.default === undefined));
      if (required) errors.add(path, "Is required");
      continue;
    }
    const raw = input[field.name];
    if (raw === null) {
      // A cleared reference array is stored as an empty list.
      if (field.optional) output[field.name] = field.type === "refArray" ? [] : null;
      else errors.add(path, "Cannot be null");
      continue;
    }
    if (field.type === "refArray" && requireAll === "none" && isPlainObject(raw)) {
      const change = validateChange(raw, path, errors);
      if (change) output[field.name] = change;
      continue;
    }
    const value = validateValue(field, raw, path, errors);
    if (value !== undefined) output[field.name] = value;
  }
  const known = new Set(fields.map((field) => field.name));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) errors.add(joinPath(prefix, key), "Unknown field");
  }
  return output;
}

function validateValue(field: ValueSpec, raw: unknown, path: string, errors: Collector): unknown {
  switch (field.type) {
    case "string": {
      if (typeof raw !== "string") return errors.add(path, "Must be a string");
      if (field.minLength !== undefined && raw.length < field.minLength) {
        return errors.add(path, `Must be at least ${field.minLength} characters`);
      }
      if (field.maxLength !== undefined && raw.length > field.maxLength) {
        return errors.add(path, `Must be at most ${field.maxLength} characters`);
      }
      if (field.format === "email" && !EMAIL.test(raw)) return errors.add(path, "Must be a valid email");
      if (field.format === "url" && !isUrl(raw)) return errors.add(path, "Must be a valid URL");
      return raw;
    }
    case "number": {
      if (typeof raw !== "number" || !Number.isFinite(raw)) return errors.add(path, "Must be a number");
      if (field.min !== undefined && raw < field.min) return errors.add(path, `Must be at least ${field.min}`);
      if (field.max !== undefined && raw > field.max) return errors.add(path, `Must be at most ${field.max}`);
      return raw;
    }
    case "boolean":
      return typeof raw === "boolean" ? raw : errors.add(path, "Must be a boolean");
    case "date": {
      if (typeof raw !== "string" || !ISO_8601.test(raw) || Number.isNaN(Date.parse(raw))) {
        return errors.add(path, "Must be an ISO 8601 date");
      }
      return new Date(raw);
    }
    case "enum":
      return typeof raw === "string" && field.values.includes(raw)
        ? raw
        : errors.add(path, `Must be one of: ${field.values.join(", ")}`);
    case "ref":
      return typeof raw === "string" && raw !== "" ? raw : errors.add(path, "Must be a string");
    case "refArray": {
      if (!Array.isArray(raw)) return errors.add(path, "Must be an array");
      if (field.minLength !== undefined && raw.length < field.minLength) {
        return errors.add(path, `Must have at least ${field.minLength} items`);
      }
      if (field.maxLength !== undefined && raw.length > field.maxLength) {
        return errors.add(path, `Must have at most ${field.maxLength} items`);
      }
      return validateIdList(raw, path, errors);
    }
    case "array": {
      if (!Array.isArray(raw)) return errors.add(path, "Must be an array");
      if (field.minLength !== undefined && raw.length < field.minLength) {
        return errors.add(path, `Must have at least ${field.minLength} items`);
      }
      if (field.maxLength !== undefined && raw.length > field.maxLength) {
        return errors.add(path, `Must have at most ${field.maxLength} items`);
      }
      return raw.map((item, index) => {
        const itemPath = `${path}[${index}]`;
        if (item === null || item === undefined) return errors.add(itemPath, "Cannot be null");
        return validateValue(field.items, item, itemPath, errors);
      });
    }
    case "object":
      if (!isPlainObject(raw)) return errors.add(path, "Must be an object");
      return validateFields(field.fields, raw, path, "replace", errors);
  }
}

export function validateBody(model: EntityModel, body: unknown, mode: ValidationMode): ValidationResult {
  if (!isPlainObject(body)) {
    return { ok: false, details: [{ field: "", message: "Body must be a JSON object" }] };
  }
  const errors = new Collector();
  const writable: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if ((SYSTEM_FIELDS as readonly string[]).includes(key)) errors.add(key, "Field is read-only");
    else writable[key] = value;
  }
  const value = validateFields(model.fields, writable, "", mode === "patch" ? "none" : mode, errors);
  return errors.details.length > 0 ? { ok: false, details: errors.details } : { ok: true, value };
}
