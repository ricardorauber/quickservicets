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
export function markTenancy(models: readonly EntityModel[], databases: Readonly<Record<string, "per-tenant" | "shared">> = {}): EntityModel[] {
  const byKey = new Map(models.map((model) => [model.key, model]));
  const decided = new Map<string, "tenant" | "shared">();
  const decide = (model: EntityModel, seen: Set<string> = new Set()): "tenant" | "shared" => {
    const known = decided.get(model.key);
    if (known) return known;
    let value: "tenant" | "shared";
    const source = sourceOf(model);
    // A named database's tenancy decides for the entities living in it, even in a module folder (an explicit schema).
    const placed = model.database !== undefined ? databases[model.database] : undefined;
    if (placed && source && byKey.has(source) && !seen.has(source)) value = decide(byKey.get(source)!, new Set([...seen, model.key]));
    else if (placed && !model.system && !SHARED_ENTITY_KEYS.has(model.key) && model.feature !== "tenancy") value = placed === "per-tenant" ? "tenant" : "shared";
    else if (model.schema) value = "shared";
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

/**
 * The models without the marks of `markTenancy` and `derivedFrom`, as a build without tenancy writes them; with named
 * databases (models that record theirs), `derivedFrom` stays, so a derived table follows its entity's database.
 */
export function withoutTenancyMarks(models: readonly EntityModel[]): EntityModel[] {
  return models.map((model) => {
    const keepsSource = model.database !== undefined;
    if (model.tenancy === undefined && (model.derivedFrom === undefined || keepsSource)) return model;
    const { tenancy: _tenancy, derivedFrom, ...rest } = model;
    return (keepsSource && derivedFrom !== undefined ? { ...rest, derivedFrom } : rest) as EntityModel;
  });
}

/**
 * The problems of `@tenancy` tags that contradict their named database: `@tenancy shared` on an entity of a
 * per-tenant database, or `@tenancy tenant` on one of a shared database, each naming the file.
 */
export function databaseTenancyProblems(models: readonly EntityModel[], databases: Readonly<Record<string, "per-tenant" | "shared">>): string[] {
  return models.flatMap((model) => {
    const placed = model.database !== undefined ? databases[model.database] : undefined;
    const scope = model.tags?.tenancy?.on ? model.tags.tenancy.options.scope : undefined;
    if (!placed || model.feature || scope === undefined) return [];
    const file = `entities/${model.key}.ts`;
    if (placed === "per-tenant" && scope === "shared") return [`${file}: ${model.entityName} lives in database ${model.database}, which is per tenant; move it to a shared database or remove @tenancy shared`];
    if (placed === "shared" && scope === "tenant") return [`${file}: ${model.entityName} lives in database ${model.database}, which is shared; move it to a per-tenant database or remove @tenancy tenant`];
    return [];
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
