import { expect, test } from "bun:test";
import { join } from "node:path";
import { build } from "../build/build.ts";
import { createLinkedProject, MEMORY_CONFIG } from "../testing/project.ts";

const TICK = 'import { job } from "@quickservicets/core";\nexport default job({ every: "1s" }, (ctx) => { ctx.log.info("tick"); return "ok"; });\n';

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

/** Starts the generated server and collects its stdout until `until` matches or `ms` pass. */
async function serve(root: string, env: Record<string, string>, ms: number, until?: RegExp): Promise<string> {
  const child = Bun.spawn(["bun", join(root, ".generated/server.ts")], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "development", PORT: String(freePort()), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  let output = "";
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + ms;
  const read = (async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      output += decoder.decode(chunk.value, { stream: true });
    }
  })();
  while (Date.now() < deadline && !(until && until.test(output))) await Bun.sleep(50);
  child.kill();
  await child.exited;
  await read.catch(() => undefined);
  return output;
}

test("the generated server runs the scheduled jobs unless JOBS_ENABLED=false", async () => {
  const root = createLinkedProject({ "quickservicets.config.ts": MEMORY_CONFIG, "jobs/tick.ts": TICK });
  await build(root);
  const disabled = await serve(root, { JOBS_ENABLED: "false" }, 3000);
  expect(disabled).toContain("QuickService.ts listening on");
  expect(disabled).not.toContain("job.started");
  const enabled = await serve(root, { JOBS_ENABLED: "true" }, 15000, /"message":"job\.finished"/);
  expect(enabled).toContain("QuickService.ts listening on");
  expect(enabled).toMatch(/"message":"tick".*"job":"tick"/);
  expect(enabled).toMatch(/"message":"job\.finished","job":"tick","runId":"[^"]+","status":"success"/);
}, 30000);
