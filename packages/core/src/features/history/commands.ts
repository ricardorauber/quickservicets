import { existsSync } from "node:fs";
import { join } from "node:path";
import { boolean, defineCommand, object, string, type CommandContext, type DatabaseAdapter, type EntityModel } from "../public.ts";
import type { HistoryRetentionFunction, HistoryStore } from "./api.ts";
import { coveredEntities, historyModelKey, type HistoryCoverage } from "./model.ts";
import { pruneHistory, pruneVersions, type PruneRun, type PruneTarget } from "./prune.ts";
import { databaseHistoryStore } from "./store.ts";

type HistoryOptions = { entities: HistoryCoverage; retention?: string | HistoryRetentionFunction; store?: HistoryStore };

/** The covered entities of the built project, each with its retention: its `@history retention=` tag, else the option. */
export function pruneTargets(models: readonly EntityModel[], options: HistoryOptions): PruneTarget[] {
  return coveredEntities(models, options.entities).map((entity) => ({
    entity,
    retention: (entity.tags?.history?.options.retention as string | undefined) ?? options.retention,
  }));
}

/** The store versions are pruned from: the configured one, or the history tables of the models. */
export function pruneStores(adapter: DatabaseAdapter, models: readonly EntityModel[], options: HistoryOptions): Pick<PruneRun, "store" | "database"> {
  if (options.store) return { store: options.store };
  const tables = new Map(
    coveredEntities(models, options.entities).flatMap((entity) => {
      const model = models.find((candidate) => candidate.key === historyModelKey(entity) && candidate.system);
      return model ? [[entity.entityName, model] as const] : [];
    }),
  );
  const store = databaseHistoryStore(adapter, tables, (model, before, keepLatest) => pruneVersions(adapter, model, { before, keepLatest }));
  return { store, database: { adapter, store } };
}

const prune = defineCommand({
  name: "history prune",
  usage: "quickservicets history prune [--entity <Name>] [--dry-run]",
  description: "Deletes the versions older than their entity's retention, keeping the current version of every live record, and prints the count per entity.",
  flags: object({
    entity: string().optional().describe("Prunes only this entity."),
    dryRun: boolean().default(false).describe("Prints what would be deleted without deleting it."),
  }),
  async run(ctx) {
    const options = (ctx as CommandContext<unknown, HistoryOptions>).options;
    await ctx.connect();
    const file = join(ctx.cwd, ".generated/models.ts");
    const models = existsSync(file) ? ((await import(file)) as { models: EntityModel[] }).models : [];
    let targets = pruneTargets(models, options);
    if (ctx.flags.entity !== undefined) {
      targets = targets.filter((target) => target.entity.entityName === ctx.flags.entity);
      if (targets.length === 0) {
        ctx.output.error(`Unknown history entity ${ctx.flags.entity}`);
        return 1;
      }
    }
    if (!targets.some((target) => target.retention !== undefined)) {
      ctx.output.log("No retention configured; nothing to prune");
      return 0;
    }
    const counts = await pruneHistory({
      ...pruneStores(ctx.config.database, models, options),
      targets,
      ...(ctx.config.logger ? { logger: ctx.config.logger } : {}),
      dryRun: ctx.flags.dryRun,
    });
    for (const [entity, count] of Object.entries(counts)) {
      ctx.output.log(`${entity}: ${count} versions ${ctx.flags.dryRun ? "would be deleted" : "deleted"}`);
    }
    return 0;
  },
});

/** The commands of the `history` native. */
export const historyCommands = [prune];
