import { existsSync } from "node:fs";
import { join } from "node:path";
import { boolean, defineCommand, jsonLogger, object, oneOf, string, type CommandContext, type EntityModel, type Repositories } from "../public.ts";
import { TENANT_ID } from "./resolve.ts";
import { schemaNameOf } from "./scopes.ts";
import { provision, strategyResolver, tenantOperations, type TenantOperations, type TenantWriter } from "./tenants.ts";

/** Connects to the database and builds the tenant operations of the project, with the `Tenant` repository. */
async function prepare(ctx: CommandContext<unknown, unknown>): Promise<{ operations: TenantOperations; repos: Repositories }> {
  const repos = await ctx.connect();
  const file = join(ctx.cwd, ".generated/models.ts");
  const models = existsSync(file) ? ((await import(file)) as { models: EntityModel[] }).models : [];
  return { operations: tenantOperations({ config: ctx.config, models, projectRoot: ctx.cwd, logger: ctx.config.logger ?? jsonLogger }), repos };
}

/** Fails like every `tenants` write command of a source other than the database. */
function requireDatabaseSource(ctx: CommandContext<unknown, unknown>, command: string): boolean {
  const source = (ctx.options as { source?: string }).source;
  if (source === "database") return true;
  ctx.output.error(`tenants ${command} needs tenancy: { source: "database" }`);
  return false;
}

const tenantsOf = (repos: Repositories) => (repos as unknown as Record<string, TenantWriter>).tenants!;

const listCommand = defineCommand({
  name: "tenants list",
  usage: "quickservicets tenants list [--pending]",
  description: "Prints each tenant with its status, strategy, schema name or database, and plan; --pending adds its number of pending migrations.",
  flags: object({ pending: boolean().default(false).describe("Adds the number of migrations each tenant has not applied.") }),
  json: { tenants: [{ id: "string", status: "string", strategy: "string", schema: "string?", plan: "string?", pending: "number?" }] },
  async run(ctx) {
    const { operations } = await prepare(ctx);
    const listed: Record<string, unknown>[] = [];
    const strategyOf = strategyResolver(operations.options.strategy);
    for await (const tenant of operations.directory.list()) {
      const strategy = await strategyOf(tenant);
      const place = strategy === "schema" ? schemaNameOf(tenant, operations.options.schema) : "database";
      // A tenant whose database cannot be opened shows ? instead of a count.
      const pending = ctx.flags.pending ? await operations.pending(tenant).catch(() => "?" as const) : undefined;
      ctx.output.log(`${tenant.id} ${tenant.status} ${strategy} ${place} ${tenant.plan ?? "-"}${pending === undefined ? "" : ` pending=${pending}`}`);
      listed.push({ id: tenant.id, status: tenant.status, strategy, schema: strategy === "schema" ? place : null, plan: tenant.plan ?? null, ...(typeof pending === "number" ? { pending } : {}) });
    }
    if (listed.length === 0) ctx.output.log("No tenants.");
    ctx.result({ tenants: listed });
  },
});

const createCommand = defineCommand({
  name: "tenants create",
  usage: "quickservicets tenants create <id> [--plan <plan>] [--strategy <schema|database>] [--schema <name>] [--connection <value>]",
  description: "Adds a tenant of the database source as suspended, migrates its schema or database, then makes it active.",
  args: [{ name: "id", required: true, description: "The tenant's id: lowercase letters, digits and dashes." }],
  flags: object({
    plan: string().optional().describe("The tenant's plan."),
    strategy: oneOf(["schema", "database"]).optional().describe("Where the tenant's data lives, over tenancy.strategy."),
    schema: string().optional().describe("The tenant's schema name, over the tenancy.schema template."),
    connection: string().optional().describe("The connection of a database-strategy tenant; it is never printed."),
  }),
  async run(ctx) {
    if (!requireDatabaseSource(ctx, "create")) return 1;
    const id = ctx.args.id!;
    if (!TENANT_ID.test(id)) {
      ctx.output.error("Invalid tenant id: use lowercase letters, digits and dashes, starting with a letter or digit");
      return 2;
    }
    const { operations, repos } = await prepare(ctx);
    const { plan, strategy, schema, connection } = ctx.flags;
    try {
      await provision(operations, tenantsOf(repos), { id, ...(plan ? { plan } : {}), ...(strategy ? { strategy } : {}), ...(schema ? { schema } : {}), ...(connection ? { connection } : {}) });
    } catch (error) {
      const message = (error as Error).message;
      if (message === `Tenant ${id} already exists`) {
        ctx.output.error(message);
        return 1;
      }
      ctx.output.error(`Created ${id} as suspended: ${message}; fix it and run quickservicets migrate --tenant ${id}, then quickservicets tenants resume ${id}`);
      return 1;
    }
    ctx.output.log(`Created ${id}`);
  },
});

/** `tenants suspend` and `tenants resume`: set the status of a tenant of the database source. */
function statusCommand(command: "suspend" | "resume", status: "suspended" | "active") {
  return defineCommand({
    name: `tenants ${command}`,
    usage: `quickservicets tenants ${command} <id>`,
    description: command === "suspend" ? "Suspends a tenant of the database source: its requests answer 403." : "Makes a suspended tenant of the database source active again.",
    args: [{ name: "id", required: true, description: "The tenant's id." }],
    async run(ctx) {
      if (!requireDatabaseSource(ctx, command)) return 1;
      const { repos } = await prepare(ctx);
      const tenants = tenantsOf(repos);
      const row = await tenants.findOne([{ field: "key", op: "eq", value: ctx.args.id }]);
      if (!row) {
        ctx.output.error(`Unknown tenant ${ctx.args.id}`);
        return 1;
      }
      await tenants.update(row.id, { status });
      ctx.output.log(`${command === "suspend" ? "Suspended" : "Resumed"} ${ctx.args.id}`);
    },
  });
}

export const tenancyCommands = [listCommand, createCommand, statusCommand("suspend", "suspended"), statusCommand("resume", "active")];
