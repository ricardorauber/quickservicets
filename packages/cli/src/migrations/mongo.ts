import { mongoIndexSpecs, type EntityModel, type MongoIndexSpec } from "@quickservicets/core";
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

const database = (spec: MongoIndexSpec) => (spec.schema ? `ctx.db(${JSON.stringify(spec.schema)})` : "ctx.db()");
const createIndex = (spec: MongoIndexSpec) =>
  `await ${database(spec)}.collection(${JSON.stringify(spec.collection)}).createIndex(${JSON.stringify(spec.keys)}, ${JSON.stringify({ name: spec.name, ...spec.options })});`;
const dropIndex = (spec: MongoIndexSpec) =>
  `await ${database(spec)}.collection(${JSON.stringify(spec.collection)}).dropIndex(${JSON.stringify(spec.name)});`;

const key = (spec: MongoIndexSpec) =>
  `${spec.schema ?? ""}\u0000${spec.collection}\u0000${spec.name}\u0000${JSON.stringify([spec.keys, spec.options])}`;

/** Index changes between the latest snapshot and the current models, as `up` and `down` statements. */
export function planMongoMigration(projectRoot: string, models: EntityModel[]): MongoMigrationPlan {
  const previous = readLatestSnapshot(projectRoot);
  const previousModels = previous?.models ?? [];
  // Join collections whose relation is unchanged but whose name changed are renamed, keeping their documents.
  const renames = previousModels
    .filter((model) => model.link)
    .flatMap((model) => {
      const current = models.find((candidate) => candidate.key === model.key);
      return current && current.tableName !== model.tableName ? [{ schema: model.schema, from: model.tableName, to: current.tableName }] : [];
    });
  const renamed = (collection: string, schema: string | null) =>
    renames.find((rename) => rename.from === collection && rename.schema === schema)?.to ?? collection;
  const before = (previous?.dialect === "mongodb" ? previous.indexes : []).map((spec) => ({
    ...spec,
    collection: renamed(spec.collection, spec.schema),
  }));
  const after = models.flatMap(mongoIndexSpecs);
  const beforeKeys = new Set(before.map(key));
  const afterKeys = new Set(after.map(key));
  const added = after.filter((spec) => !beforeKeys.has(key(spec)));
  const removed = before.filter((spec) => !afterKeys.has(key(spec)));

  const kept = (model: EntityModel) =>
    models.some((current) => (current.tableName === model.tableName || current.key === model.key) && current.schema === model.schema);
  const todos = previousModels
    .filter((model) => !kept(model))
    .map((model) => `// TODO: data in collection ${model.tableName} is kept; drop it here if intended`);

  const db = (schema: string | null) => (schema ? `ctx.db(${JSON.stringify(schema)})` : "ctx.db()");
  const renameUp = renames.map((rename) => `await ${db(rename.schema)}.collection(${JSON.stringify(rename.from)}).rename(${JSON.stringify(rename.to)});`);
  const renameDown = renames.map((rename) => `await ${db(rename.schema)}.collection(${JSON.stringify(rename.to)}).rename(${JSON.stringify(rename.from)});`);
  return {
    dialect: "mongodb",
    models,
    indexes: after,
    previousModels,
    up: [...todos, ...renameUp, ...removed.map(dropIndex), ...added.map(createIndex)],
    down: [...added.map(dropIndex), ...removed.map(createIndex), ...renameDown],
  };
}
