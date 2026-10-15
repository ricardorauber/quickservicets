import { HttpError, type FieldErrorDetail } from "../errors.ts";
import type { EntityModel, Exposure, ReadOperation } from "../model.ts";
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

function readList(
  model: EntityModel,
  exposure: Exposure,
  params: URLSearchParams,
  name: "fields" | "exclude",
  details: FieldErrorDetail[],
): string[] | undefined {
  const raw = params.get(name);
  if (raw === null) return undefined;
  const entries = raw.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
  if (entries.length === 0) {
    details.push({ field: name, message: "Must list at least one field" });
    return undefined;
  }
  const parsed = parseFieldPaths(model, entries);
  const paths = parsed.ok ? parsed.paths : entries;
  const unknown = paths.filter((path) => (!parsed.ok && parsed.invalid.includes(path)) || !isExposed(exposure, path));
  for (const path of unknown) details.push({ field: name, message: `Unknown field: ${path}` });
  return unknown.length > 0 ? undefined : paths;
}

/** Validates the `fields` and `exclude` query parameters of a list or read route. */
export function parseClientSelection(model: EntityModel, operation: ReadOperation, params: URLSearchParams): ClientSelection {
  const exposure = model.exposure[operation];
  const details: FieldErrorDetail[] = [];
  const fields = readList(model, exposure, params, "fields", details);
  const exclude = readList(model, exposure, params, "exclude", details);
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
