import { HttpError, type FieldErrorDetail } from "../errors.ts";
import type { EntityModel, Exposure, FieldModel, ReadOperation } from "../model.ts";
import { parseFieldPaths, project } from "../projection.ts";

const overlaps = (path: string, other: string) => path === other || path.startsWith(`${other}.`) || other.startsWith(`${path}.`);
const inside = (path: string, other: string) => path === other || path.startsWith(`${other}.`);

/** Whether a path (or part of it) is returned by an operation, given its exposure. */
export function isExposed(exposure: Exposure, path: string): boolean {
  return exposure.include.some((included) => overlaps(path, included)) && !exposure.exclude.some((excluded) => inside(path, excluded));
}

export interface ClientSelection {
  fields?: string[];
  exclude?: string[];
}

export interface SelectionContext {
  /** Populated reference paths of this request; selection may reach inside them. */
  populated?: string[];
  models?: EntityModel[];
}

/** Whether `path` reaches inside a populated reference and is exposed by the referenced entity. */
function withinPopulated(model: EntityModel, exposure: Exposure, path: string, context: SelectionContext): boolean {
  for (const populated of context.populated ?? []) {
    if (!path.startsWith(`${populated}.`) || !isExposed(exposure, populated.split(".")[0]!)) continue;
    let target: EntityModel | undefined = model;
    for (const segment of populated.split(".")) {
      const field: FieldModel | undefined = target?.fields.find((candidate) => candidate.name === segment);
      const key: string | undefined = field?.type === "ref" || field?.type === "refArray" ? field.target : undefined;
      target = context.models?.find((candidate) => candidate.key === key);
    }
    if (!target) continue;
    const rest = path.slice(populated.length + 1);
    if (withinPopulated(target, target.exposure.read, rest, { ...context, populated: (context.populated ?? []).filter((other) => other.startsWith(`${populated}.`)).map((other) => other.slice(populated.length + 1)) })) {
      return true;
    }
    const parsed = parseFieldPaths(target, [rest]);
    if (parsed.ok && isExposed(target.exposure.read, rest)) return true;
  }
  return false;
}

function readList(
  model: EntityModel,
  exposure: Exposure,
  params: URLSearchParams,
  name: "fields" | "exclude",
  details: FieldErrorDetail[],
  context: SelectionContext,
): string[] | undefined {
  const raw = params.get(name);
  if (raw === null) return undefined;
  const entries = raw.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
  if (entries.length === 0) {
    details.push({ field: name, message: "Must list at least one field" });
    return undefined;
  }
  const paths = [...new Set(entries)];
  const valid = (path: string) => {
    if (withinPopulated(model, exposure, path, context)) return true;
    return parseFieldPaths(model, [path]).ok && isExposed(exposure, path);
  };
  const unknown = paths.filter((path) => !valid(path));
  for (const path of unknown) details.push({ field: name, message: `Unknown field: ${path}` });
  return unknown.length > 0 ? undefined : paths;
}

/** Validates the `fields` and `exclude` query parameters of a list or read route. */
export function parseClientSelection(
  model: EntityModel,
  operation: ReadOperation,
  params: URLSearchParams,
  context: SelectionContext = {},
): ClientSelection {
  const exposure = model.exposure[operation];
  const details: FieldErrorDetail[] = [];
  const fields = readList(model, exposure, params, "fields", details, context);
  const exclude = readList(model, exposure, params, "exclude", details, context);
  if (fields && exclude) {
    for (const path of exclude) {
      if (!fields.some((selected) => inside(path, selected))) {
        details.push({ field: "exclude", message: `Field is not selected: ${path}` });
      }
    }
  }
  if (details.length > 0) throw new HttpError(400, "Invalid query", { details });
  return { ...(fields ? { fields } : {}), ...(exclude ? { exclude } : {}) };
}

/** Applies the operation's exposure, then the client's selection. */
export function selectFields(value: unknown, exposure: Exposure, selection: ClientSelection = {}): unknown {
  const exposed = project(value, exposure);
  if (!selection.fields && !selection.exclude) return exposed;
  return project(exposed, { include: selection.fields, exclude: selection.exclude });
}
