import type { EntityModel } from "../public.ts";

/** The core's and the natives' own entities: their records belong to the service, never to one tenant. */
export const SHARED_ENTITY_KEYS: ReadonlySet<string> = new Set(["JobRun", "QueueMessage", "OutboxEvent", "OutboxDelivery", "RateLimitCounter", "FeatureFlag", "IdempotencyKey", "Tenant"]);

/** The entity a derived model follows: a history table its entity, a link entity its left side. */
const sourceOf = (model: EntityModel): string | undefined => model.derivedFrom ?? model.link?.left.entity;

/**
 * Sets `tenancy` on every model: `shared` for entities with an explicit schema, entities tagged `@tenancy shared`,
 * models whose contributor declared `tenancy: "shared"` and the core's own entities; derived models take the value of
 * the model they derive from; every other model holds tenant data.
 */
export function markTenancy(models: readonly EntityModel[]): EntityModel[] {
  const byKey = new Map(models.map((model) => [model.key, model]));
  const decided = new Map<string, "tenant" | "shared">();
  const decide = (model: EntityModel, seen: Set<string> = new Set()): "tenant" | "shared" => {
    const known = decided.get(model.key);
    if (known) return known;
    let value: "tenant" | "shared";
    const source = sourceOf(model);
    if (model.schema) value = "shared";
    else if (model.tags?.tenancy?.on && model.tags.tenancy.options.scope === "shared") value = "shared";
    else if (model.tenancy) value = model.tenancy;
    else if (source && byKey.has(source) && !seen.has(source)) value = decide(byKey.get(source)!, new Set([...seen, model.key]));
    else if (model.system || SHARED_ENTITY_KEYS.has(model.key) || model.feature === "tenancy") value = "shared";
    else value = "tenant";
    decided.set(model.key, value);
    return value;
  };
  return models.map((model) => ({ ...model, tenancy: decide(model) }));
}

/** The models without the marks of `markTenancy` and `derivedFrom`, as a build without tenancy writes them. */
export function withoutTenancyMarks(models: readonly EntityModel[]): EntityModel[] {
  return models.map((model) => {
    if (model.tenancy === undefined && model.derivedFrom === undefined) return model;
    const { tenancy: _tenancy, derivedFrom: _derivedFrom, ...rest } = model;
    return rest as EntityModel;
  });
}

/**
 * The problems of references that cross the line between tenant and shared data, each naming the file: a tenant may
 * live in another database, so its records can only keep the ids of shared ones in string fields, and the reverse.
 */
export function crossTenancyReferences(models: readonly EntityModel[]): string[] {
  const byKey = new Map(models.map((model) => [model.key, model]));
  const problems: string[] = [];
  for (const model of models) {
    if (model.link) continue;
    for (const field of model.fields) {
      if (field.type !== "ref" && field.type !== "refArray") continue;
      const target = byKey.get(field.target);
      if (!target || target.tenancy === undefined || model.tenancy === undefined || target.tenancy === model.tenancy) continue;
      const file = `entities/${model.key}.ts`;
      problems.push(
        model.tenancy === "tenant"
          ? `${file}: ${model.entityName} holds tenant data and cannot reference ${target.entityName}, which is shared; store its id in a string field`
          : `${file}: ${model.entityName} is shared and cannot reference ${target.entityName}, which holds tenant data; store its id in a string field`,
      );
    }
  }
  return problems;
}
