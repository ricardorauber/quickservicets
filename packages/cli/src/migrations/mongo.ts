import { mongoIndexSpecs, type EntityModel, type MongoIndexSpec } from "@quickservice/core";
import { readLatestSnapshot } from "./snapshot.ts";

export interface MongoMigrationPlan {
  dialect: "mongodb";
  models: EntityModel[];
  indexes: MongoIndexSpec[];
  previousModels: EntityModel[];
  /** TypeScript statements of `up` and `down`. */
  up: string[];
  down: string[];
}

const createIndex = (spec: MongoIndexSpec) =>
  `await ctx.db().collection(${JSON.stringify(spec.collection)}).createIndex(${JSON.stringify(spec.keys)}, ${JSON.stringify({ name: spec.name, ...spec.options })});`;
const dropIndex = (spec: MongoIndexSpec) =>
  `await ctx.db().collection(${JSON.stringify(spec.collection)}).dropIndex(${JSON.stringify(spec.name)});`;

const key = (spec: MongoIndexSpec) => `${spec.collection}\u0000${spec.name}\u0000${JSON.stringify([spec.keys, spec.options])}`;

/** Index changes between the latest snapshot and the current models, as `up` and `down` statements. */
export function planMongoMigration(projectRoot: string, models: EntityModel[]): MongoMigrationPlan {
  const previous = readLatestSnapshot(projectRoot);
  const before = previous?.dialect === "mongodb" ? previous.indexes : [];
  const previousModels = previous?.models ?? [];
  const after = models.flatMap(mongoIndexSpecs);
  const beforeKeys = new Set(before.map(key));
  const afterKeys = new Set(after.map(key));
  const added = after.filter((spec) => !beforeKeys.has(key(spec)));
  const removed = before.filter((spec) => !afterKeys.has(key(spec)));

  const kept = (model: EntityModel) => models.some((current) => current.tableName === model.tableName);
  const todos = previousModels
    .filter((model) => !kept(model))
    .map((model) => `// TODO: data in collection ${model.tableName} is kept; drop it here if intended`);

  return {
    dialect: "mongodb",
    models,
    indexes: after,
    previousModels,
    up: [...todos, ...removed.map(dropIndex), ...added.map(createIndex)],
    down: [...added.map(dropIndex), ...removed.map(createIndex)],
  };
}
