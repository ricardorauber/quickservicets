import type { EntityModel, ResolvedFeature } from "@quickservice/core";
import { BuildError } from "../errors.ts";

/** An entity tagged `@publish` and where its write events go. */
export interface PublishTarget {
  entity: EntityModel;
  queue: string;
  events: readonly string[];
  fields?: readonly string[];
}

type PublishOptions = { queue: string; events: string[]; fields?: string[] };

/** The entities tagged `@publish`, with their tag's options over `queues.publish`; none while `queues` is off. */
export function publishTargets(models: readonly EntityModel[], features: readonly ResolvedFeature[]): PublishTarget[] {
  const queues = features.find((feature) => feature.key === "queues");
  if (!queues) return [];
  const defaults = (queues.options as { publish?: PublishOptions }).publish ?? { queue: "events", events: ["created", "updated", "deleted"] };
  return models.flatMap((entity) => {
    const tag = entity.tags?.publish;
    if (entity.system || entity.link || !tag?.on) return [];
    const options = { ...defaults, ...(tag.options as Partial<PublishOptions>) };
    return [{ entity, queue: options.queue, events: options.events, ...(options.fields ? { fields: options.fields } : {}) }];
  });
}

/**
 * Fails for a `fields` entry that is not a field of its entity; returns a warning per target queue that has no
 * consumer file while messages stay in the database.
 */
export function publishProblems(targets: readonly PublishTarget[], queueNames: ReadonlySet<string>, databaseBroker = true): string[] {
  for (const { entity, fields = [] } of targets) {
    const known = new Set(entity.fields.map((field) => field.name));
    const unknown = fields.find((name) => !known.has(name));
    if (unknown !== undefined) throw new BuildError(`entities/${entity.key}.ts: invalid @publish: unknown field ${unknown}`);
  }
  if (!databaseBroker) return [];
  return targets
    .filter((target) => !queueNames.has(target.queue))
    .map((target) => `@publish on ${target.entity.entityName} sends to queue ${target.queue}, which has no consumer in queues/ and no broker`);
}
