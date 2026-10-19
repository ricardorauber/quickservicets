import { expect, test } from "bun:test";
import { join } from "node:path";
import { build } from "../build/build.ts";
import { createLinkedProject } from "../testing/project.ts";

const config = (grace: string) => `import { defineConfig, memoryAdapter } from "@quickservice/core";
export default defineConfig({ database: memoryAdapter(), jobs: { shutdownGrace: "${grace}" } });
`;

const STUBBORN = 'import { job } from "@quickservice/core";\nexport default job({ every: "1s" }, () => new Promise((resolve) => setTimeout(resolve, 60_000)));\n';
const POLITE =
  'import { job } from "@quickservice/core";\nexport default job({ every: "1s" }, (ctx) => new Promise((resolve) => ctx.signal.addEventListener("abort", () => resolve("stopped"))));\n';

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

/** Starts the generated server, sends `signal` once a job has started, and collects its output until it exits. */
async function signalDuringJob(root: string, signal: "SIGTERM" | "SIGINT") {
  const child = Bun.spawn(["bun", join(root, ".generated/server.ts")], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "development", PORT: String(freePort()) },
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
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !output.includes('"message":"job.started"')) await Bun.sleep(25);
  expect(output).toContain('"message":"job.started"');
  const signaledAt = Date.now();
  child.kill(signal);
  const exitCode = await Promise.race([child.exited, Bun.sleep(20_000).then(() => "still running" as const)]);
  const elapsed = Date.now() - signaledAt;
  if (exitCode === "still running") child.kill("SIGKILL");
  await read.catch(() => undefined);
  return { output, exitCode, elapsed };
}

test("SIGTERM records a job that ignores the signal as interrupted after the grace period, then exits", async () => {
  const root = createLinkedProject({ "quickservice.config.ts": config("2s"), "jobs/stubborn.ts": STUBBORN });
  await build(root);
  const { output, exitCode, elapsed } = await signalDuringJob(root, "SIGTERM");
  expect(exitCode).toBe(0);
  expect(elapsed).toBeGreaterThanOrEqual(1900);
  expect(elapsed).toBeLessThan(10_000);
  expect(output).toMatch(/"message":"job\.finished","job":"stubborn","runId":"[^"]+","status":"interrupted"/);
}, 45_000);

test("SIGINT lets a job that stops on the signal record its own outcome, and exits without waiting for the grace", async () => {
  const root = createLinkedProject({ "quickservice.config.ts": config("30s"), "jobs/polite.ts": POLITE });
  await build(root);
  const { output, exitCode, elapsed } = await signalDuringJob(root, "SIGINT");
  expect(exitCode).toBe(0);
  expect(elapsed).toBeLessThan(10_000);
  expect(output).toMatch(/"message":"job\.finished","job":"polite","runId":"[^"]+","status":"success"/);
  expect(output).not.toContain('"status":"interrupted"');
}, 45_000);
