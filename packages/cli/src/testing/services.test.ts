import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INFRA_CATALOG, type Exec, type InfraService } from "@quickservicets/core";
import { servicesAvailable, startServices, testServiceVariable, TEST_CONTAINER_LABEL } from "./services.ts";
import { startTestService } from "./service.ts";

/** A fake Docker that maps every container port to 40000 + its number and records the commands. */
const fakeDocker = (options: { failUp?: boolean } = {}) => {
  const commands: string[][] = [];
  const exec: Exec = async (command) => {
    commands.push([...command]);
    const action = command[command.indexOf("-p") + 2];
    if (action === "up" && options.failUp) return { code: 1, stdout: "", stderr: "dependency failed to start: container is unhealthy" };
    if (action === "port") return { code: 0, stdout: `127.0.0.1:${40000 + Number(command.at(-1)) % 10000}\n`, stderr: "" };
    if (action === "ps") return { code: 0, stdout: `${JSON.stringify({ Service: "slow", State: "running", Health: "unhealthy" })}\n`, stderr: "" };
    if (action === "logs") return { code: 0, stdout: Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const actions = () => commands.map((command) => command[command.indexOf("-p") + 2]);
  return { exec, commands, actions };
};

describe("ports and variables", () => {
  test("every container port gets a random host port and the variables use them", async () => {
    const docker = fakeDocker();
    const services = await startServices(["postgres", "redis"], { exec: docker.exec, env: {} });
    const up = docker.commands.find((command) => command.includes("up"))!;
    expect(up.slice(up.indexOf("-p") + 1, up.indexOf("-p") + 2)[0]).toMatch(/^qs-test-[0-9a-f]{12}$/);
    expect(up.slice(-5)).toEqual(["up", "-d", "--wait", "--wait-timeout", "90"]);
    expect(services.env).toEqual({ DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:45432/app", REDIS_URL: "redis://127.0.0.1:46379" });
    expect(services.urls).toEqual({ postgres: "postgres://postgres:postgres@127.0.0.1:45432/app", redis: "redis://127.0.0.1:46379" });
    await services.stop();
  });

  test("requirement names of the project's description are accepted", async () => {
    const docker = fakeDocker();
    const cache: InfraService = { name: "cache", kind: "redis", description: "Cache", image: INFRA_CATALOG.redis.image, ports: [6379], credentials: {}, environment: {}, env: { CACHE_URL: "redis://{host}:{port}" }, optional: false, owners: ["test"] };
    const services = await startServices(["cache"], { exec: docker.exec, env: {}, services: [cache] });
    expect(services.env).toEqual({ CACHE_URL: "redis://127.0.0.1:46379" });
    await services.stop();
    await expect(startServices(["nope"], { exec: docker.exec, env: {} })).rejects.toThrow("Unknown service nope");
  });
});

describe("cleanup", () => {
  test("stop runs docker compose down with the volumes, and the exit handlers are installed", async () => {
    const docker = fakeDocker();
    const services = await startServices(["redis"], { exec: docker.exec, env: {} });
    expect(process.listeners("exit").some((listener) => listener.name === "stopTestServicesNow")).toBe(true);
    await services.stop();
    const down = docker.commands.at(-1)!;
    expect(down.slice(-4)).toEqual(["down", "--volumes", "--timeout", "1"]);
  });
});

describe("reuse", () => {
  test("two calls with reuse share one project, stopped after both stops", async () => {
    const docker = fakeDocker();
    const first = await startServices(["redis"], { exec: docker.exec, env: {}, reuse: true });
    const second = await startServices(["redis"], { exec: docker.exec, env: {}, reuse: true });
    expect(docker.actions().filter((action) => action === "up")).toHaveLength(1);
    expect(second.env).toEqual(first.env);
    await first.stop();
    expect(docker.actions()).not.toContain("down");
    await second.stop();
    expect(docker.actions().filter((action) => action === "down")).toHaveLength(1);
    // After the last stop, a new call starts a new project.
    const third = await startServices(["redis"], { exec: docker.exec, env: {}, reuse: true });
    expect(docker.actions().filter((action) => action === "up")).toHaveLength(2);
    await third.stop();
  });
});

describe("variables and skipped tests", () => {
  test("TEST_POSTGRES_URL is used as it is, and no container starts", async () => {
    const docker = fakeDocker();
    const url = "postgres://ci:pw@db.ci:6543/ci";
    expect(testServiceVariable("postgres")).toBe("TEST_POSTGRES_URL");
    const services = await startServices(["postgres"], { exec: docker.exec, env: { TEST_POSTGRES_URL: url } });
    expect(docker.commands).toEqual([]);
    expect(services.env.DATABASE_URL).toBe(url);
    expect(services.urls.postgres).toBe(url);
    await services.stop();
  });

  test("without Docker and without the variable, describeWithServices registers one named skipped test", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qs-skip-"));
    try {
      mkdirSync(join(dir, "node_modules/@quickservicets"), { recursive: true });
      symlinkSync(join(import.meta.dir, "../.."), join(dir, "node_modules/@quickservicets/cli"), "dir");
      symlinkSync(join(import.meta.dir, "../../../core"), join(dir, "node_modules/@quickservicets/core"), "dir");
      writeFileSync(
        join(dir, "skip.test.ts"),
        'import { describeWithServices } from "@quickservicets/cli/testing";\ndescribeWithServices(["redis"], () => { throw new Error("must not run"); }, { env: { PATH: "/nowhere" } });\n',
      );
      const child = Bun.spawnSync([process.execPath, "test", "--reporter=junit", "--reporter-outfile=report.xml"], { cwd: dir, env: { ...process.env, TEST_REDIS_URL: "" }, stdout: "pipe", stderr: "pipe" });
      expect(child.exitCode).toBe(0);
      const report = readFileSync(join(dir, "report.xml"), "utf8");
      expect(report).toContain('name="redis: Docker is not available (set TEST_REDIS_URL to use an existing service)"');
      expect(report).toContain("<skipped");
      expect(`${child.stdout.toString()}${child.stderr.toString()}`).toContain("1 skip");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("health timeouts", () => {
  test("a failed health wait stops the project and names the service with its last 20 log lines", async () => {
    const docker = fakeDocker({ failUp: true });
    const slow: InfraService = { name: "slow", kind: "custom", description: "Never healthy", image: "busybox:1.37.0", ports: [8080], health: ["CMD", "false"], credentials: {}, environment: {}, env: {}, optional: false, owners: ["test"] };
    const failure = await startServices(["slow"], { exec: docker.exec, env: {}, services: [slow], timeout: "5s" }).catch((error: Error) => error);
    expect((failure as Error).message).toBe(`Service slow did not become healthy within 5s\n${Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n")}`);
    expect(docker.actions().slice(-1)).toEqual(["down"]);
    expect(docker.commands.find((command) => command.includes("logs"))!.slice(-3)).toEqual(["--tail", "20", "slow"]);
  });
});

const docker = await servicesAvailable();
const DATABASE = "qs_b13_test_containers";

describe.skipIf(!docker)("with Docker", () => {
  test("PostgreSQL starts on a random port, answers select 1, and stop removes the containers and volumes", async () => {
    const services = await startServices(["postgres"], { env: { ...process.env, TEST_POSTGRES_URL: "" } });
    expect(Number(new URL(services.env.DATABASE_URL!).port)).toBeGreaterThan(1024);
    const sql = new Bun.SQL(services.env.DATABASE_URL!);
    try {
      expect([...((await sql`select 1 as one`) as { one: number }[])]).toEqual([{ one: 1 }]);
    } finally {
      await sql.close();
    }
    const labeled = () => Bun.spawnSync(["docker", "ps", "-a", "--filter", `label=${TEST_CONTAINER_LABEL}=true`, "--filter", `label=com.docker.compose.project=${services.project}`, "--format", "{{.Names}}"]).stdout.toString().trim();
    const volumes = () => Bun.spawnSync(["docker", "volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${services.project}`]).stdout.toString().trim();
    expect(labeled()).not.toBe("");
    await services.stop();
    expect(labeled()).toBe("");
    expect(volumes()).toBe("");
  }, 120_000);

  test("SIGTERM in the test process stops its containers", async () => {
    const script = join(import.meta.dir, `.signal-${crypto.randomUUID()}.ts`);
    writeFileSync(script, `import { startServices } from "./services.ts";\nconst services = await startServices(["redis"], { env: { ...process.env, TEST_REDIS_URL: "" } });\nconsole.log("READY " + services.project);\nsetInterval(() => {}, 1000);\n`);
    try {
      const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "inherit" });
      const reader = child.stdout.getReader();
      let text = "";
      while (!text.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      const project = /READY (\S+)/.exec(text)?.[1];
      expect(project).toStartWith("qs-test-");
      child.kill("SIGTERM");
      expect(await child.exited).toBe(143);
      const left = Bun.spawnSync(["docker", "ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Names}}"]).stdout.toString().trim();
      expect(left).toBe("");
    } finally {
      rmSync(script, { force: true });
    }
  }, 120_000);

  test("containers a bun test process leaves are removed once it exits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qs-left-"));
    try {
      mkdirSync(join(dir, "node_modules/@quickservicets"), { recursive: true });
      symlinkSync(join(import.meta.dir, "../.."), join(dir, "node_modules/@quickservicets/cli"), "dir");
      symlinkSync(join(import.meta.dir, "../../../core"), join(dir, "node_modules/@quickservicets/core"), "dir");
      writeFileSync(
        join(dir, "left.test.ts"),
        'import { test } from "bun:test";\nimport { startServices } from "@quickservicets/cli/testing";\ntest("leaves its services running", async () => {\n  const services = await startServices(["redis"], { env: { ...process.env, TEST_REDIS_URL: "" } });\n  console.log("PROJECT " + services.project);\n}, 120000);\n',
      );
      const child = Bun.spawnSync([process.execPath, "test"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      const project = /PROJECT (\S+)/.exec(`${child.stdout}${child.stderr}`)?.[1];
      expect(project).toStartWith("qs-test-");
      const left = () => Bun.spawnSync(["docker", "ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Names}}"]).stdout.toString().trim();
      const deadline = Date.now() + 30_000;
      while (left() !== "" && Date.now() < deadline) await Bun.sleep(500);
      expect(left()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test("a service whose health check never passes rejects with its logs", async () => {
    const slow: InfraService = { name: "slow", kind: "custom", description: "Never healthy", image: "busybox:1.37.0", command: ["sh", "-c", "echo waiting-for-nothing; sleep 300"], ports: [8080], health: ["CMD", "false"], credentials: {}, environment: {}, env: {}, optional: false, owners: ["test"] };
    const failure = (await startServices(["slow"], { services: [slow], timeout: "4s" }).catch((error: Error) => error)) as Error;
    expect(failure.message.split("\n")[0]).toBe("Service slow did not become healthy within 4s");
    expect(failure.message).toContain("waiting-for-nothing");
  }, 120_000);

  test("startTestService with services serves the project from PostgreSQL and stops it", async () => {
    const labeled = () => Bun.spawnSync(["docker", "ps", "-a", "--filter", `label=${TEST_CONTAINER_LABEL}=true`, "--format", "{{.Names}}"]).stdout.toString().trim();
    const before = labeled();
    const service = await startTestService({
      files: {
        "quickservicets.config.ts": 'import { defineConfig, postgresAdapter } from "@quickservicets/core";\nexport default defineConfig({ database: postgresAdapter({ url: process.env.DATABASE_URL! }) });\n',
        "entities/Post.ts": "export type Post = { title: string };\n",
      },
      services: ["postgres"],
      env: { TEST_POSTGRES_URL: "" },
    });
    let url = "";
    try {
      expect((await service.fetch("/posts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: DATABASE }) })).status).toBe(201);
      expect(await (await service.fetch("/posts")).json()).toMatchObject({ total: 1, data: [{ title: DATABASE }] });
      url = service.env.DATABASE_URL!;
      const sql = new Bun.SQL(url);
      try {
        expect([...((await sql`select title from posts`) as { title: string }[])]).toEqual([{ title: DATABASE }]);
      } finally {
        await sql.close();
      }
    } finally {
      await service.stop();
    }
    expect(url).toStartWith("postgres://");
    expect(labeled()).toBe(before);
  }, 180_000);
});
