import type { DatabaseAdapter } from "../adapter.ts";
import { HttpError, type FieldErrorDetail } from "../errors.ts";
import type { EntityModel, FieldModel } from "../model.ts";
import { mimeMatches } from "./limits.ts";

export type FileReference = Extract<FieldModel, { type: "ref" }>;

/** The file entity a field references, or undefined when the field is not a reference to a file entity. */
export function fileTargetOf(field: FieldModel | undefined, models: EntityModel[]): EntityModel | undefined {
  if (field?.type !== "ref") return undefined;
  const target = models.find((model) => model.key === field.target);
  return target?.file ? target : undefined;
}

/** Checks the files that fields with `@maxSize`/`@accept` reference by id against those field rules. */
export async function assertReferencedFilesAllowed(
  model: EntityModel,
  value: Record<string, unknown>,
  models: EntityModel[],
  adapter: DatabaseAdapter,
): Promise<void> {
  const details: FieldErrorDetail[] = [];
  for (const field of model.fields) {
    const id = value[field.name];
    const limits = field.fileLimits;
    const target = fileTargetOf(field, models);
    if (!limits || !target || typeof id !== "string") continue;
    const file = await adapter.findById(target, id);
    if (!file) continue;
    if (limits.maxSize !== undefined && Number(file.size) > limits.maxSize) {
      details.push({ field: field.name, message: "File too large" });
    } else if (limits.accept !== undefined && !mimeMatches(String(file.mimeType), limits.accept)) {
      details.push({ field: field.name, message: "File type not allowed" });
    }
  }
  if (details.length > 0) throw new HttpError(400, "Invalid body", { details });
}
