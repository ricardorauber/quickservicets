import { isValidCollectionName, populatePathErrors, SYSTEM_FIELDS, type EntityModel, type ResolvedFeature } from "@quickservice/core";
import { EntityParseError } from "./errors.ts";
import { entityOverrideLine, withBuiltInEntities } from "./parse-entities.ts";

const ENTITY_NAME = /^[A-Z][A-Za-z0-9]*$/;
const FIELD_NAME = /^[A-Za-z_$][\w$]*$/;
const FIELD_TYPES = new Set(["string", "number", "boolean", "date", "ref", "refArray", "enum", "array", "object", "json"]);

/** Who owns a model, for error messages. */
function ownerOf(model: EntityModel): string {
  if (model.feature) return model.feature;
  if (model.link) return `entities/${model.link.left.entity}.ts (field "${model.link.left.field}")`;
  return `entities/${model.key}.ts`;
}

const sameScope = (a: EntityModel, b: EntityModel) => (a.schema ?? null) === (b.schema ?? null);

/** Checks the shape of one model returned by a feature, before it joins the model. */
function assertShape(key: string, value: unknown): asserts value is EntityModel {
  const fail = (reason: string) => new EntityParseError(`${key}: ${reason}`);
  if (typeof value !== "object" || value === null || !Array.isArray((value as EntityModel).fields)) {
    throw fail("entities must be entity models; build them with entityModel(...)");
  }
  const model = value as EntityModel;
  if (typeof model.entityName !== "string" || !ENTITY_NAME.test(model.entityName)) {
    throw fail(`entity names must be PascalCase (got ${JSON.stringify(model.entityName)})`);
  }
  const entity = `entity ${model.entityName}`;
  if (typeof model.name !== "string" || !isValidCollectionName(model.name)) {
    throw fail(`${entity}: collection "${String(model.name)}" must match ^[a-z][a-z0-9-]*$`);
  }
  if (model.schema !== null && (typeof model.schema !== "string" || !isValidCollectionName(model.schema))) {
    throw fail(`${entity}: schema "${String(model.schema)}" must match ^[a-z][a-z0-9-]*$`);
  }
  const names = new Set<string>();
  for (const field of model.fields) {
    if (typeof field?.name !== "string" || !FIELD_NAME.test(field.name)) throw fail(`${entity}: invalid field name ${JSON.stringify(field?.name)}`);
    if ((SYSTEM_FIELDS as readonly string[]).includes(field.name)) {
      throw fail(`${entity}: field "${field.name}" is a system field added to every entity and cannot be declared`);
    }
    if (names.has(field.name)) throw fail(`${entity}: field "${field.name}" is declared more than once`);
    names.add(field.name);
    if (!FIELD_TYPES.has(field.type)) throw fail(`${entity}: field "${field.name}" has unsupported type ${JSON.stringify(field.type)}`);
  }
}

/** Fails when a contributed model takes the name, collection or table of a model already in the project's model. */
function assertNoClash(key: string, model: EntityModel, models: readonly EntityModel[]): void {
  for (const other of models) {
    const clash =
      other.key === model.key
        ? `the entity ${model.key}`
        : sameScope(other, model) && other.name === model.name
          ? `the collection name "${model.name}"`
          : sameScope(other, model) && other.tableName === model.tableName
            ? `the table name "${model.tableName}"`
            : undefined;
    if (!clash) continue;
    if (other.feature && other.feature !== key) throw new EntityParseError(`Features ${other.feature} and ${key} both contribute ${clash}`);
    throw new EntityParseError(`${key}: entity ${model.entityName} uses ${clash}, which ${ownerOf(other)} already uses`);
  }
}

/** Fails when a contributed model references an entity that does not exist or has an invalid populate path. */
function assertReferences(key: string, model: EntityModel, models: EntityModel[]): void {
  for (const field of model.fields) {
    if ((field.type === "ref" || field.type === "refArray") && !models.some((candidate) => candidate.key === field.target)) {
      throw new EntityParseError(`${key}: entity ${model.entityName}: field "${field.name}" references ${field.target}, which is not an entity`);
    }
  }
  for (const path of new Set([...(model.populate?.list ?? []), ...(model.populate?.read ?? [])])) {
    const [error] = populatePathErrors(model, models, path, Number.POSITIVE_INFINITY);
    if (error) throw new EntityParseError(`${key}: entity ${model.entityName}: invalid populate: ${error}`);
  }
}

/**
 * Adds the entities that features declare as `entityModel` lists or functions, in feature order: functions receive
 * the models parsed so far. A project entity with the same name replaces a contributed one.
 */
export function withContributedEntities(parsed: EntityModel[], features: readonly ResolvedFeature[]): { models: EntityModel[]; overrides: string[] } {
  const models = [...parsed];
  const overrides: string[] = [];
  for (const feature of features) {
    const entities = feature.definition.entities;
    if (entities === undefined || typeof entities === "string") continue;
    let contributed: unknown;
    try {
      contributed = typeof entities === "function" ? entities({ models: [...models], options: feature.options as never }) : entities;
    } catch (error) {
      throw new EntityParseError(`${feature.key}: entities: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!Array.isArray(contributed)) throw new EntityParseError(`${feature.key}: entities must return a list of entity models`);
    const added: EntityModel[] = [];
    for (const value of contributed) {
      assertShape(feature.key, value);
      const replacement = models.find((model) => model.key === value.key && !model.feature && !model.link);
      if (replacement) {
        overrides.push(entityOverrideLine(`entities/${replacement.key}.ts`, value.key, feature.key));
        continue;
      }
      const model: EntityModel = { ...value, feature: feature.key };
      assertNoClash(feature.key, model, withBuiltInEntities(models));
      models.push(model);
      added.push(model);
    }
    const known = withBuiltInEntities(models);
    for (const model of added) assertReferences(feature.key, model, known);
  }
  return { models, overrides };
}
