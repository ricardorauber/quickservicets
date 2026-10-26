import { existsSync } from "node:fs";
import { join } from "node:path";
import { boolean, defineCommand, object, string, type CommandContext, type EntityModel } from "../public.ts";
import { coveredEntities, historyModelKey, type HistoryCoverage } from "./model.ts";
import { pruneHistory, type PruneTarget } from "./prune.ts";

type HistoryOptions = { entities: HistoryCoverage; retention?: string };

/** The covered entities of the built project, each with its history model and retention. */
export function pruneTargets(models: readonly EntityModel[], options: HistoryOptions): PruneTarget[] {
  return coveredEntities(models, options.entities).flatMap((entity) => {
    const model = models.find((candidate) => candidate.key === historyModelKey(entity) && candidate.system);
    return model ? [{ entity, model, retention: options.retention }] : [];
  });
}

const prune = defineCommand({
  name: "history prune",
  usage: "quickservice history prune [--entity <Name>] [--dry-run]",
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
    const counts = await pruneHistory({ adapter: ctx.config.database, targets, ...(ctx.config.logger ? { logger: ctx.config.logger } : {}), dryRun: ctx.flags.dryRun });
    for (const [entity, count] of Object.entries(counts)) {
      ctx.output.log(`${entity}: ${count} versions ${ctx.flags.dryRun ? "would be deleted" : "deleted"}`);
    }
    return 0;
  },
});

/** The commands of the `history` native. */
export const historyCommands = [prune];
