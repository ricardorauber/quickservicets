import { expect, test } from "bun:test";
import { join } from "node:path";
import { build } from "../build/build.ts";
import { addMigration } from "../migrations/add.ts";
import { migrate } from "../migrations/migrate.ts";
import { createLinkedProject } from "../testing/project.ts";

const SCHEMA = "workerjobs";
// The run result records which worker ran the job.
const TICK = 'import { job } from "@quickservicets/core";\nexport default job({ every: "1s" }, () => process.env.QS_WORKER_INDEX ?? "none");\n';

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

const postgresUrl = process.env.TEST_POSTGRES_URL;
(postgresUrl ? test : test.skip)("with two workers the scheduler runs in worker 0 only and each scheduled run is claimed once", async () => {
  const { SQL } = await import("bun");
  const admin = new SQL(postgresUrl!);
  await admin.unsafe('drop schema if exists "workerjobs" cascade');
  const root = createLinkedProject({
    "quickservicets.config.ts": `import { defineConfig, postgresAdapter } from "@quickservicets/core";
export default defineConfig({ database: postgresAdapter({ url: ${JSON.stringify(postgresUrl)} }), schema: "${SCHEMA}", server: { workers: 2 } });
`,
    "jobs/tick.ts": TICK,
  });
  try {
    await addMigration(root, "Initial", new Date(Date.UTC(2026, 9, 15, 12)));
    await migrate(root);
    await build(root);
    const child = Bun.spawn(["bun", join(root, ".generated/server.ts")], {
      cwd: root,
      env: { ...process.env, NODE_ENV: "development", PORT: String(freePort()), QS_WORKERS: "", QS_WORKER_INDEX: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    let output = "";
    const decoder = new TextDecoder();
    const reader = child.stdout.getReader();
    const read = (async () => {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        output += decoder.decode(chunk.value, { stream: true });
      }
    })();
    const finished = () => output.match(/"message":"job\.finished"/g)?.length ?? 0;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && finished() < 3) await Bun.sleep(50);
    child.kill("SIGTERM");
    const exitCode = await Promise.race([child.exited, Bun.sleep(20_000).then(() => "still running" as const)]);
    if (exitCode === "still running") child.kill("SIGKILL");
    await read.catch(() => undefined);

    expect(exitCode).toBe(0);
    expect(output.match(/QuickService.ts listening on/g)).toHaveLength(2);
    expect(output.match(/"message":"worker\.started"/g)).toHaveLength(2);
    expect(finished()).toBeGreaterThanOrEqual(3);
    const runs = (await admin.unsafe(`select scheduled_at, result from "workerjobs".job_runs where trigger = 'schedule'`)) as { scheduled_at: Date; result: unknown }[];
    expect(runs.length).toBeGreaterThanOrEqual(3);
    expect(new Set(runs.map((run) => new Date(run.scheduled_at).getTime())).size).toBe(runs.length);
    // The result column holds the JSON text of the job's return value.
    expect(new Set(runs.map((run) => (typeof run.result === "string" ? JSON.parse(run.result) : run.result)))).toEqual(new Set(["0"]));
  } finally {
    await admin.unsafe('drop schema if exists "workerjobs" cascade');
    await admin.close();
  }
}, 60_000);
