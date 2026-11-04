import { boolean, defineCommand, defineFeature, duration, hook, INFRA_CATALOG, INFRA_KINDS, integer, object, provider, record, string, type CommandContext, type FeatureHook } from "../public.ts";
import type { ComposeDocument, DevOptions } from "./compose.ts";
import type { ContainerRunner } from "./services.ts";
import { LocalServicesError, localServicesEnv, localServicesLogs, localServicesStatus, startLocalServices, stopLocalServices, type LocalServicesContext } from "./services.ts";

export { COMPOSE_HEADER, COMPOSE_OVERRIDE_FILE, composeDocument, composeProjectName, composeYaml, localServicesPlan, serviceSetting, writeWhenChanged } from "./compose.ts";
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
  setUpDevDependents,
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
  beforeCompose: hook<ComposeDocument, { project: string }>().describe("Runs before the compose file is written, with the compose document as an object; returning a document replaces it, like adding an `adminer` service."),
  afterUp: hook<{ services: { name: string; image: string; port: number }[]; env: Record<string, string> }, undefined>().describe("Runs once the services are healthy, with each service's name, image and host port and every resolved connection variable."),
  runner: provider<ContainerRunner>("ContainerRunner", ["up", "down", "status", "logs"])
    .optional()
    .describe("Replaces the `docker compose` calls of the local services and test containers, like a runner calling `podman compose`: `up`, `down`, `status` and `logs` receive the compose files, the project name and a signal."),
});

/** The setup API of the `dev` native. */
export interface DevApi {
  /** Adds a hook after the ones written in the config. */
  addHook(name: "beforeCompose", fn: FeatureHook<ComposeDocument, { project: string }>): void;
  addHook(name: "afterUp", fn: FeatureHook<{ services: { name: string; image: string; port: number }[]; env: Record<string, string> }, undefined>): void;
}

/** The catalog kinds as a reference table. */
const catalogTable = [
  "| Kind | Image | Ports | Variables |",
  "| --- | --- | --- | --- |",
  ...INFRA_KINDS.map((kind) => {
    const entry = INFRA_CATALOG[kind];
    return `| \`${kind}\` | \`${entry.image}\` | ${entry.ports.join(", ")} | ${Object.keys(entry.templates).map((name) => `\`${name}\``).join(", ")} |`;
  }),
].join("\n");

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
  docs: {
    summary: "Local services for development: `quickservicets dev --services` starts the database and every service the project's features need with Docker Compose.",
    sections: [
      {
        title: "Services",
        text: "The services come from `describeInfrastructure(config)`: `database` (and `database-<name>` per named database) for PostgreSQL and MongoDB, `minio` for an S3 storage without an `endpoint`, and every requirement an enabled feature declares in `infra`. A `services` entry applies to the service of that name, or to the only service of that kind (`services.postgres` reaches the `database` service on PostgreSQL). Variables like `QS_DEV_SERVICES_POSTGRES_PORT` set the options of entries present in the config. The project file `dev/compose.override.yml` is passed to Docker Compose after the generated file.",
      },
      {
        title: "The ContainerRunner contract",
        text: "`runner` replaces every `docker compose` call of `quickservicets dev --services`, the `services` commands and the test containers of `@quickservicets/cli/testing`:\n\n```ts\ninterface ContainerRunner {\n  up(call: { files: string[]; project: string; cwd: string; signal?: AbortSignal; waitSeconds: number }): Promise<void>;\n  down(call: { files: string[]; project: string; cwd: string; signal?: AbortSignal; volumes?: boolean }): Promise<void>;\n  status(call: { files: string[]; project: string; cwd: string; signal?: AbortSignal }): Promise<{ service: string; state: string; health: string }[]>;\n  logs(call: { files: string[]; project: string; cwd: string; signal?: AbortSignal; service?: string; tail?: number }): Promise<string>;\n}\n```\n\n`dockerComposeRunner(exec, env, command)` builds the default one; `dockerComposeRunner(spawnExec, process.env, [\"podman\", \"compose\"])` runs Podman instead.",
      },
      { title: "Catalog", text: `The kinds a requirement may use, with their pinned images:\n\n${catalogTable}` },
    ],
  },
  enabledByDefault: true,
  options,
  commands,
  api: (ctx): DevApi => ({ addHook: ctx.addHook as DevApi["addHook"] }),
});

export default devFeature;
