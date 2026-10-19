/** The commands of the `quickservice` CLI, for help texts and the reference documentation. */
export interface CommandDoc {
  name: string;
  usage: string;
  description: string;
}

export const COMMANDS: CommandDoc[] = [
  {
    name: "init",
    usage: "quickservice init [directory] [--db postgres|mongodb|sqlite|memory]",
    description: "Creates a project; inside the QuickService monorepo it also links the workspace packages and installs them.",
  },
  {
    name: "dev",
    usage: "quickservice dev",
    description: "Builds and serves the project, rebuilding and restarting when entities, endpoints, hooks or the config change.",
  },
  {
    name: "build",
    usage: "quickservice build",
    description: "Generates `.generated/`: models, routes, types, the OpenAPI document and the server entry.",
  },
  {
    name: "migrate",
    usage: "quickservice migrate [target] [--force]",
    description: "Applies pending migrations, or migrates up or down to the target migration.",
  },
  { name: "migration add", usage: "quickservice migration add <Name>", description: "Creates a migration from the model changes since the last one." },
  { name: "migration list", usage: "quickservice migration list", description: "Lists the migrations and whether each one is applied." },
  { name: "migration remove", usage: "quickservice migration remove", description: "Removes the latest migration when it is not applied." },
  {
    name: "migration script",
    usage: "quickservice migration script [from] [to] [--output <file>]",
    description: "Prints, or writes to a file, the SQL of the migrations between two points.",
  },
  {
    name: "job run",
    usage: "quickservice job run <name> [--force]",
    description:
      "Runs a job now in the CLI process as a `manual` run, printing its status, duration and result or error; exits with 1 unless it succeeds. `--force` runs it even while another run of the job is running.",
  },
  { name: "job list", usage: "quickservice job list", description: "Lists every job with its schedule, time zone and next run time." },
  {
    name: "job runs",
    usage: "quickservice job runs <name> [--limit n]",
    description: "Lists the latest runs of a job (20 by default) with their attempt, trigger, status, start and duration.",
  },
  { name: "--version", usage: "quickservice --version", description: "Prints the CLI version." },
];
