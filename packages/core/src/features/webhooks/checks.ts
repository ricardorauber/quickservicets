import type { EntityModel, FieldModel } from "../public.ts";
import { SUBSCRIPTION_FIELDS } from "./models.ts";

/** A field type as messages name it: `string`, `string[]`, `date`, `boolean` or `json`. */
function typeName(field: Pick<FieldModel, "type"> & { items?: { type: string } }): string {
  if (field.type === "array") return `${field.items?.type ?? "unknown"}[]`;
  return field.type;
}

/** Whether a project's field can hold what the native stores in one of its own. */
function compatible(own: FieldModel, project: FieldModel): boolean {
  if (own.type === "json") return project.type === "json" || project.type === "object";
  return typeName(own as never) === typeName(project as never);
}

/**
 * What the build refuses in the models the native reads: an `@webhooks fields=` naming a field the entity does not
 * have, and a project `WebhookSubscription` missing a field of the native's, or changing its type.
 */
export function buildProblems(models: readonly EntityModel[]): string[] {
  const problems: string[] = [];
  for (const model of models) {
    const fields = model.tags?.webhooks?.on ? (model.tags.webhooks.options.fields as readonly string[] | undefined) : undefined;
    for (const name of fields ?? []) {
      if (name !== "id" && !model.fields.some((field) => field.name === name)) problems.push(`entities/${model.key}.ts: invalid @webhooks: unknown field ${name}`);
    }
  }
  const replaced = models.find((model) => model.key === "WebhookSubscription" && model.feature === undefined);
  if (replaced) {
    for (const own of SUBSCRIPTION_FIELDS) {
      const project = replaced.fields.find((field) => field.name === own.name);
      // Entity files cannot declare JSON fields, so a project's subscription may leave `headers` out.
      if (!project && own.type === "json") continue;
      if (!project || !compatible(own, project)) problems.push(`entities/WebhookSubscription.ts: WebhookSubscription needs the field ${own.name} (${typeName(own as never)}) used by webhooks`);
    }
  }
  return problems;
}
