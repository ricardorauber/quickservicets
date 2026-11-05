import { expect, test } from "bun:test";
import { defineFeature, triggerCheckpointEntity, type ResolvedFeature } from "@quickservicets/core";
import { withContributedEntities } from "./feature-entities.ts";

const feature = (key: string): ResolvedFeature => ({ key, options: { enabled: true }, definition: defineFeature({ key, entities: [triggerCheckpointEntity] }), native: false, project: true });

test("a shared system entity contributed by two features is kept once", () => {
  const { models } = withContributedEntities([], [feature("kinesis"), feature("dynamo")]);
  expect(models.map((model) => [model.key, model.feature])).toEqual([["TriggerCheckpoint", "kinesis"]]);
});
