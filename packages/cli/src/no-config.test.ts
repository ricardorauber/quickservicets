import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { watchProject, WATCHED_PATHS } from "./dev/dev.ts";
import { run } from "./run.ts";
import { startTestService } from "./testing/service.ts";
import { createLinkedProject } from "./testing/project.ts";

const TASK = "export type Task = { title: string };\n";

async function cli(args: string[], cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, { log: (line) => out.push(line), error: (line) => err.push(line) }, cwd);
  return { code, out, err };
}

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

describe("a project without quickservicets.config.ts", () => {
  test("builds, and its generated server answers from the memory database", async () => {
    const root = createLinkedProject({ "package.json": '{ "name": "tiny", "type": "module" }\n', "entities/Task.ts": TASK });
    try {
      expect((await cli(["build"], root)).code).toBe(0);
      const server = readFileSync(join(root, ".generated/server.ts"), "utf8");
      expect(server).not.toContain("quickservicets.config.ts");
      expect(server).toContain("const projectConfig: ServiceConfig = {};");
      const port = freePort();
      const child = Bun.spawn(["bun", join(root, ".generated/server.ts")], { cwd: root, env: { ...process.env, NODE_ENV: "development", QS_SERVER_PORT: String(port) }, stdout: "ignore", stderr: "ignore" });
      try {
        const deadline = Date.now() + 15_000;
        let created: Response | undefined;
        while (Date.now() < deadline && !created) {
          created = await fetch(`http://localhost:${port}/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"title":"Write"}' }).catch(() => undefined);
          if (!created) await Bun.sleep(100);
        }
        expect(created?.status).toBe(201);
        const list = (await (await fetch(`http://localhost:${port}/tasks`)).json()) as { data: { title: string }[]; total: number };
        expect(list.total).toBe(1);
        expect(list.data[0]!.title).toBe("Write");
      } finally {
        child.kill();
        await child.exited;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);

  test("startTestService serves it", async () => {
    const service = await startTestService({ files: { "entities/Task.ts": TASK } });
    try {
      expect((await service.fetch("/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: '{"title":"a"}' })).status).toBe(201);
      expect(((await (await service.fetch("/tasks")).json()) as { total: number }).total).toBe(1);
    } finally {
      await service.stop();
    }
  }, 30_000);

  test("migration add exits 1 with the memory message, and migrate has nothing to migrate", async () => {
    const root = createLinkedProject({ "entities/Task.ts": TASK });
    try {
      const add = await cli(["migration", "add", "Init"], root);
      expect(add.code).toBe(1);
      expect([...add.out, ...add.err].join("\n")).toContain("Migrations are not used with the memory adapter");
      const migrate = await cli(["migrate"], root);
      expect(migrate.code).toBe(0);
      expect(migrate.out.join("\n")).toContain("Nothing to migrate");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

test("a config file whose default export is not an object fails the build naming the file", async () => {
  const root = createLinkedProject({ "quickservicets.config.ts": "export default 42;\n", "entities/Task.ts": TASK });
  try {
    const result = await cli(["build"], root);
    expect(result.code).toBe(3);
    expect(result.err.join("\n")).toContain(join(root, "quickservicets.config.ts"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("dev watching the config file", () => {
  test("the config file is watched", () => {
    expect(WATCHED_PATHS).toContain("quickservicets.config.ts");
  });

  test("creating, changing and deleting quickservicets.config.ts are each noticed", async () => {
    const root = createLinkedProject({ "entities/Task.ts": TASK });
    const changes: (string | undefined)[] = [];
    const watcher = watchProject(root, WATCHED_PATHS, (changed) => changes.push(changed));
    const file = join(root, "quickservicets.config.ts");
    const noticed = async () => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !changes.includes("quickservicets.config.ts")) await Bun.sleep(25);
      const seen = changes.includes("quickservicets.config.ts");
      changes.length = 0;
      // Events of one write can arrive in several bursts; let them settle before the next step.
      await Bun.sleep(150);
      changes.length = 0;
      return seen;
    };
    try {
      await Bun.sleep(100);
      writeFileSync(file, "export default { server: { port: 4001 } };\n");
      expect(await noticed()).toBe(true);
      writeFileSync(file, "export default { server: { port: 4002 } };\n");
      expect(await noticed()).toBe(true);
      unlinkSync(file);
      expect(await noticed()).toBe(true);
      writeFileSync(join(root, "unrelated.txt"), "x");
      await Bun.sleep(300);
      expect(changes).not.toContain("unrelated.txt");
    } finally {
      watcher.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
