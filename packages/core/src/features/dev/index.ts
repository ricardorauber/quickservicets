import { boolean, defineCommand, defineFeature, duration, integer, object, record, string, type CommandContext } from "../public.ts";
import type { DevOptions } from "./compose.ts";
import { LocalServicesError, localServicesEnv, localServicesLogs, localServicesStatus, startLocalServices, stopLocalServices, type LocalServicesContext } from "./services.ts";

export { COMPOSE_HEADER, COMPOSE_OVERRIDE_FILE, composeDocument, composeProjectName, composeYaml, localServicesPlan, writeWhenChanged } from "./compose.ts";
export type { ComposeDocument, DevOptions, LocalService, LocalServicesPlan } from "./compose.ts";
export {
  composeCall,
  DEVELOPMENT_ONLY,
  DOCKER_MISSING,
  dockerAvailable,
  dockerComposeRunner,
  envFileValues,
  LocalServicesError,
  localServicesEnv,
  localServicesLogs,
  localServicesStatus,
  parseComposeStatus,
  planLocalServices,
  portFree,
  portInUse,
  spawnExec,
  startLocalServices,
  stopLocalServices,
} from "./services.ts";
export type { ComposeCall, ContainerRunner, ContainerStatus, Exec, ExecResult, LocalServicesContext, StartedServices } from "./services.ts";

const options = object({
  services: record(
    object({
      enabled: boolean().default(true).describe("Starts this service; false leaves it to you."),
      image: string().optional().describe("Replaces the catalog's image of this service."),
      port: integer().min(1).max(65535).optional().describe("The host port of the service's first container port (default: the catalog's)."),
      env: record(string().describe("The value of one container variable.")).optional().describe("Variables added to the service's container."),
    }),
  ).describe("Settings of the local services, keyed by requirement name (`database`, `redis`, `minio`…)."),
  composeFile: string().default(".generated/dev/compose.yml").describe("Where the generated Docker Compose file is written, relative to the project."),
  project: string().optional().describe("The Docker Compose project name (default: the package name, without its scope)."),
  wait: duration().default("60s").describe("How long `services up` waits for every health check before failing."),
});

/** The local services context of a command. */
const contextOf = (ctx: CommandContext<unknown, unknown>): LocalServicesContext => ({
  root: ctx.cwd,
  config: ctx.config as unknown as LocalServicesContext["config"],
  options: ctx.options as DevOptions,
  log: (line) => ctx.output.log(line),
});

/** Runs a command body, printing a local services failure and exiting with 1. */
const guarded = async (ctx: CommandContext<unknown, unknown>, body: () => Promise<void>): Promise<number> => {
  try {
    await body();
    return 0;
  } catch (error) {
    if (!(error instanceof LocalServicesError)) throw error;
    ctx.output.error(error.message);
    return 1;
  }
};

const commands = [
  defineCommand({
    name: "services up",
    usage: "quickservicets services up",
    description: "Writes the Docker Compose file of the services the project needs (its database, Redis, a broker and what its features ask for) and starts them, waiting for their health checks.",
    async run(ctx) {
      return guarded(ctx, async () => {
        await startLocalServices(contextOf(ctx));
      });
    },
  }),
  defineCommand({
    name: "services down",
    usage: "quickservicets services down [--volumes]",
    description: "Stops and removes the local services' containers; `--volumes` also removes their data.",
    flags: object({ volumes: boolean().default(false).describe("Also removes the services' named volumes.") }),
    async run(ctx) {
      return guarded(ctx, () => stopLocalServices(contextOf(ctx), ctx.flags.volumes));
    },
  }),
  defineCommand({
    name: "services status",
    usage: "quickservicets services status",
    description: "Prints each local service with its container's state, health and host port.",
    async run(ctx) {
      return guarded(ctx, async () => {
        for (const line of await localServicesStatus(contextOf(ctx))) ctx.output.log(line);
      });
    },
  }),
  defineCommand({
    name: "services logs",
    usage: "quickservicets services logs [name]",
    description: "Prints the logs of the local services, or of one.",
    args: [{ name: "name", description: "The service, like `database` or `redis`." }],
    async run(ctx) {
      return guarded(ctx, async () => {
        const text = await localServicesLogs(contextOf(ctx), ctx.args.name);
        if (text.trim() !== "") ctx.output.log(text.trimEnd());
      });
    },
  }),
  defineCommand({
    name: "services env",
    usage: "quickservicets services env [--show]",
    description: "Prints the connection variables of the local services, with passwords as `[secret]` unless `--show` is given.",
    flags: object({ show: boolean().default(false).describe("Prints the passwords.") }),
    async run(ctx) {
      return guarded(ctx, async () => {
        for (const line of localServicesEnv(contextOf(ctx), ctx.flags.show)) ctx.output.log(line);
      });
    },
  }),
];

/**
 * The `dev` native: `quickservicets dev --services` starts every service the project needs (its database and what its
 * features declare in `infra`) through a generated Docker Compose file and runs the development server connected to
 * them. Enabled by default; it acts only in the CLI and adds nothing to a running service.
 */
export const devFeature = defineFeature({
  key: "dev",
  docs: { summary: "Local services for development: `quickservicets dev --services` starts the database and every service the project's features need with Docker Compose." },
  enabledByDefault: true,
  options,
  commands,
});

export default devFeature;
