import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, portFree, startLocalServices, type ContainerRunner, type DevOptions } from "@quickservicets/core";
import { startServices } from "../testing/services.ts";
import { createLinkedProject } from "../testing/project.ts";
import { startDevServices } from "./services.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const project = (config: string, files: Record<string, string> = {}) => {
  const root = createLinkedProject({ "package.json": JSON.stringify({ name: "blog" }), "quickservicets.config.ts": config, ...files });
  roots.push(root);
  return root;
};

const picked = new Set<number>();
const freePort = (): number => {
  for (;;) {
    const port = 20_000 + Math.floor(Math.random() * 10_000);
    if (!picked.has(port) && portFree(port)) {
      picked.add(port);
      return port;
    }
  }
};

/** A runner recording its calls, standing for `podman compose`. */
const recordingRunner = () => {
  const calls: { method: string; files: string[]; project: string }[] = [];
  const runner: ContainerRunner = {
    up: async (call) => void calls.push({ method: "up", files: call.files, project: call.project }),
    down: async (call) => void calls.push({ method: "down", files: call.files, project: call.project }),
    status: async (call) => (calls.push({ method: "status", files: call.files, project: call.project }), []),
    logs: async (call) => (calls.push({ method: "logs", files: call.files, project: call.project }), ""),
  };
  return { runner, calls };
};

const devOptions = async (root: string, env: Record<string, string> = {}) => {
  const config = await loadConfig(root, env);
  return { config, options: config.features.find((feature) => feature.key === "dev")!.options as unknown as DevOptions };
};

const output = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (line: string) => out.push(line), error: (line: string) => err.push(line) };
};

describe("level 0 and variables", () => {
  test("a project without a dev key starts its services, and QS_DEV_SERVICES_POSTGRES_PORT moves a configured entry", async () => {
    const root = project(`import { defineConfig, postgresAdapter } from "@quickservicets/core";
export default defineConfig({ database: postgresAdapter({ url: "postgres://localhost/app" }), dev: { services: { postgres: { enabled: true } } } });
`);
    const port = freePort();
    const { config, options } = await devOptions(root, { QS_DEV_SERVICES_POSTGRES_PORT: String(port), QS_DEV_WAIT: "2m" });
    expect(options.services.postgres!.port).toBe(port);
    expect(options.wait).toBe("2m");
    const { runner, calls } = recordingRunner();
    const lines = output();
    await startLocalServices({ root, config: config as never, options, env: {}, runner, log: lines.log });
    expect(lines.out).toEqual([`Service database (postgres:17.11-alpine) on localhost:${port}`]);
    expect(readFileSync(join(root, ".generated/dev/compose.yml"), "utf8")).toContain(`"${port}:5432"`);
    expect(calls.map((call) => call.method)).toEqual(["up"]);
  });

  test("with no dev key at all the command runs on the defaults", async () => {
    const root = project(`import { defineConfig, postgresAdapter } from "@quickservicets/core";
export default defineConfig({ database: postgresAdapter({ url: "postgres://localhost/app" }) });
`);
    const { options } = await devOptions(root);
    expect(options).toMatchObject({ services: {}, composeFile: ".generated/dev/compose.yml", wait: "60s" });
    const { runner } = recordingRunner();
    const lines = output();
    const injected = await startDevServices(root, lines, { env: {}, runner });
    // The catalog's port 5432 may be taken on the machine running the tests; the command then names the option.
    if (portFree(5432)) expect(injected).toEqual({ DATABASE_URL: "postgres://postgres:postgres@localhost:5432/app" });
    else expect(lines.err).toEqual(["Port 5432 for database is in use; set dev.services.database.port"]);
  });
});

describe("hooks over the compose document", () => {
  test("beforeCompose adds a service to the written file and afterUp receives the resolved variables", async () => {
    const port = freePort();
    const root = project(`import { defineConfig, postgresAdapter } from "@quickservicets/core";
export const seen: unknown[] = [];
export default defineConfig({
  database: postgresAdapter({ url: "postgres://localhost/app" }),
  dev: {
    services: { database: { port: ${port} } },
    beforeCompose: (document) => ({ ...document, services: { ...document.services, adminer: { image: "adminer:4.8.1", ports: ["8080:8080"] } } }),
    afterUp: (value) => void seen.push(value),
  },
});
`);
    const { config, options } = await devOptions(root);
    const { runner } = recordingRunner();
    await startLocalServices({ root, config: config as never, options, env: {}, runner, log: () => {} });
    const compose = readFileSync(join(root, ".generated/dev/compose.yml"), "utf8");
    expect(compose).toContain("  adminer:\n    image: \"adminer:4.8.1\"\n");
    const { seen } = (await import(join(root, "quickservicets.config.ts"))) as { seen: unknown[] };
    expect(seen).toEqual([{ services: [{ name: "database", image: "postgres:17.11-alpine", port }], env: { DATABASE_URL: `postgres://postgres:postgres@localhost:${port}/app` } }]);
  });

  test("a feature after dev adds a hook through ctx.feature(\"dev\").addHook", async () => {
    const port = freePort();
    const root = project(
      `import { defineConfig, postgresAdapter } from "@quickservicets/core";
export default defineConfig({ database: postgresAdapter({ url: "postgres://localhost/app" }), dev: { services: { database: { port: ${port} } } }, mailbox: {} });
`,
      {
        "features/mailbox/index.ts": `import { defineFeature } from "@quickservicets/core";
export default defineFeature({
  key: "mailbox",
  after: ["dev"],
  setup(ctx) {
    ctx.feature("dev").addHook("beforeCompose", (document) => ({ ...document, services: { ...document.services, mailpit: { image: "axllent/mailpit:v1.21.8" } } }));
  },
});
`,
      },
    );
    const { config, options } = await devOptions(root);
    const { runner } = recordingRunner();
    await startLocalServices({ root, config: config as never, options, env: {}, runner, log: () => {} });
    expect(readFileSync(join(root, ".generated/dev/compose.yml"), "utf8")).toContain("  mailpit:\n");
  });
});

describe("the runner provider", () => {
  test("a runner in the config receives up with the file and project, and no docker process starts", async () => {
    const port = freePort();
    const root = project(`import { defineConfig, postgresAdapter, type ContainerRunner } from "@quickservicets/core";
export const calls: { method: string; files: string[]; project: string }[] = [];
const runner: ContainerRunner = {
  up: async (call) => void calls.push({ method: "up", files: call.files, project: call.project }),
  down: async (call) => void calls.push({ method: "down", files: call.files, project: call.project }),
  status: async () => [],
  logs: async () => "",
};
export default defineConfig({ database: postgresAdapter({ url: "postgres://localhost/app" }), dev: { runner, services: { database: { port: ${port} } } } });
`);
    const spawn = spyOn(Bun, "spawn");
    try {
      // No PATH, so a docker process could not start even by mistake.
      const lines = output();
      expect(typeof (await startDevServices(root, lines, { env: { PATH: "/nowhere" } }))).toBe("object");
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
    }
    const { calls } = (await import(join(root, "quickservicets.config.ts"))) as { calls: { method: string; files: string[]; project: string }[] };
    expect(calls).toEqual([{ method: "up", files: [join(root, ".generated/dev/compose.yml")], project: "blog" }]);
  });

  test("test containers use the runner too, with host ports chosen up front", async () => {
    const { runner, calls } = recordingRunner();
    const services = await startServices(["redis"], { env: {}, runner });
    expect(calls.map((call) => call.method)).toEqual(["up"]);
    const compose = readFileSync(calls[0]!.files[0]!, "utf8");
    const port = new URL(services.env.REDIS_URL!).port;
    expect(compose).toContain(`"127.0.0.1:${port}:6379"`);
    await services.stop();
    expect(calls.map((call) => call.method)).toEqual(["up", "down"]);
  });
});
