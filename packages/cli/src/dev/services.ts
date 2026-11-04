import { loadConfig, LocalServicesError, startLocalServices, type CommandOutput, type ContainerRunner, type DevOptions, type Exec } from "@quickservicets/core";

/** What `startDevServices` may replace, for tests. */
export interface DevServicesDependencies {
  env?: Record<string, string | undefined>;
  runner?: ContainerRunner;
  exec?: Exec;
}

/**
 * Starts the project's local services for `quickservicets dev --services` and resolves the variables the development
 * server receives, or the exit code after printing why they could not start.
 */
export async function startDevServices(cwd: string, output: CommandOutput, deps: DevServicesDependencies = {}): Promise<Record<string, string> | number> {
  const config = await loadConfig(cwd, deps.env ?? process.env);
  const dev = config.features.find((feature) => feature.key === "dev");
  if (!dev) {
    output.error("dev is disabled (dev: false in quickservicets.config.ts)");
    return 1;
  }
  try {
    const started = await startLocalServices({
      root: cwd,
      config: config as never,
      options: dev.options as unknown as DevOptions,
      ...(deps.env ? { env: deps.env } : {}),
      ...(deps.runner ? { runner: deps.runner } : {}),
      ...(deps.exec ? { exec: deps.exec } : {}),
      log: (line) => output.log(line),
    });
    return started.env;
  } catch (error) {
    if (!(error instanceof LocalServicesError)) throw error;
    output.error(error.message);
    return 1;
  }
}
