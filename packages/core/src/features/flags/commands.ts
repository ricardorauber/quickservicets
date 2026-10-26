import { existsSync } from "node:fs";
import { join } from "node:path";
import { boolean, defineCommand, integer, list, object, string, type CommandContext, type DatabaseAdapter, type EntityModel, type StoredRecord } from "../public.ts";
import { FLAG_NAME, FLAG_NAME_MESSAGE, type FlagRule } from "./evaluate.ts";
import { featureFlagEntity, loadFlagRows, ruleOfRow } from "./store.ts";

type FlagsOptions = { source: "config" | "database"; rules: Record<string, FlagRule> };

/** One line of `flags list`: name, origin, on or off, the user and tenant counts and the percentage. */
export function flagLine(name: string, origin: "config" | "database" | "both", rule: FlagRule): string {
  return `${name} ${origin} ${rule.enabled ? "on" : "off"} users=${rule.users?.length ?? 0} tenants=${rule.tenants?.length ?? 0} percentage=${rule.percentage ?? "-"}`;
}

/** The `FeatureFlag` model of the built project, after connecting. */
async function flagTable(ctx: CommandContext<unknown, unknown>): Promise<{ adapter: DatabaseAdapter; model: EntityModel }> {
  await ctx.connect();
  const file = join(ctx.cwd, ".generated/models.ts");
  const models = existsSync(file) ? ((await import(file)) as { models: EntityModel[] }).models : [];
  return { adapter: ctx.config.database, model: models.find((model) => model.key === "FeatureFlag") ?? featureFlagEntity() };
}

const optionsOf = (ctx: CommandContext<unknown, unknown>) => ctx.options as FlagsOptions;

const listCommand = defineCommand({
  name: "flags list",
  usage: "quickservicets flags list",
  description: "Prints each flag with its origin (config, database or both), on or off, its user and tenant counts and its percentage.",
  async run(ctx) {
    const options = optionsOf(ctx);
    let rows = new Map<string, FlagRule>();
    if (options.source === "database") {
      const { adapter, model } = await flagTable(ctx);
      rows = await loadFlagRows(adapter, model);
    }
    const names = [...new Set([...Object.keys(options.rules), ...rows.keys()])].sort();
    if (names.length === 0) ctx.output.log("No flags.");
    for (const name of names) {
      const row = rows.get(name);
      const configured = options.rules[name];
      ctx.output.log(flagLine(name, row && configured ? "both" : row ? "database" : "config", row ?? configured!));
    }
  },
});

const setCommand = defineCommand({
  name: "flags set",
  usage: "quickservicets flags set <name> [--on | --off] [--percentage <n>] [--users <a,b>] [--tenants <a,b>] [--description <text>]",
  description: "Creates or updates a flag of the database source, changing only the flags given, and prints its line.",
  args: [{ name: "name", description: "The flag's name." }],
  flags: object({
    on: boolean().default(false).describe("Turns the flag on."),
    off: boolean().default(false).describe("Turns the flag off."),
    percentage: integer().min(0).max(100).optional().describe("The share of users the flag is on for."),
    users: list(string()).optional().describe("The user ids the flag is on for, comma-separated."),
    tenants: list(string()).optional().describe("The tenant ids the flag is on for, comma-separated."),
    description: string().optional().describe("What the flag turns on."),
  }),
  async run(ctx) {
    const name = ctx.args.name ?? "";
    if (optionsOf(ctx).source !== "database") {
      ctx.output.error('flags set needs flags: { source: "database" }');
      return 1;
    }
    if (!FLAG_NAME.test(name)) {
      ctx.output.error(`Invalid flags.rules.${name}: ${FLAG_NAME_MESSAGE}`);
      return 1;
    }
    if (ctx.flags.on && ctx.flags.off) {
      ctx.output.error("Give --on or --off, not both");
      return 1;
    }
    const { adapter, model } = await flagTable(ctx);
    const changes: Record<string, unknown> = {
      ...(ctx.flags.on ? { enabled: true } : {}),
      ...(ctx.flags.off ? { enabled: false } : {}),
      ...(ctx.flags.percentage !== undefined ? { percentage: ctx.flags.percentage } : {}),
      ...(ctx.flags.users !== undefined ? { users: ctx.flags.users } : {}),
      ...(ctx.flags.tenants !== undefined ? { tenants: ctx.flags.tenants } : {}),
      ...(ctx.flags.description !== undefined ? { description: ctx.flags.description } : {}),
    };
    const now = new Date();
    const existing = await adapter.findOne(model, [{ field: "name", op: "eq", value: name }]);
    const stored = existing
      ? await adapter.updateById(model, existing.id, { ...changes, updatedAt: now })
      : await adapter.insert(model, { id: Bun.randomUUIDv7(), createdAt: now, updatedAt: now, name, enabled: true, ...changes } as StoredRecord);
    ctx.output.log(flagLine(name, "database", ruleOfRow(stored!)));
    return 0;
  },
});

const removeCommand = defineCommand({
  name: "flags remove",
  usage: "quickservicets flags remove <name>",
  description: "Deletes a flag of the database source; the config's rule of that name applies again.",
  args: [{ name: "name", description: "The flag's name." }],
  async run(ctx) {
    const name = ctx.args.name ?? "";
    const options = optionsOf(ctx);
    if (options.source !== "database") {
      ctx.output.error('flags remove needs flags: { source: "database" }');
      return 1;
    }
    if (!FLAG_NAME.test(name)) {
      ctx.output.error(`Invalid flags.rules.${name}: ${FLAG_NAME_MESSAGE}`);
      return 1;
    }
    const { adapter, model } = await flagTable(ctx);
    const existing = await adapter.findOne(model, [{ field: "name", op: "eq", value: name }]);
    if (existing) await adapter.deleteById(model, existing.id);
    ctx.output.log(options.rules[name] ? `Removed ${name}; the config rule applies again` : `Removed ${name}`);
    return 0;
  },
});

/** The commands of the `flags` native. */
export const flagCommands = [listCommand, setCommand, removeCommand];
