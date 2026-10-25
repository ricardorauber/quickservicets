import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { run } from "../run.ts";
import { createLinkedProject, MEMORY_CONFIG } from "../testing/project.ts";
import { build } from "./build.ts";

const project = () => createLinkedProject({ "quickservice.config.ts": MEMORY_CONFIG, "entities/User.ts": "export type User = { email: string };\n" });

afterEach(() => {
  delete process.env.QS_SERVR_PORT;
  delete process.env.QS_SERVER_PORT;
});

test("an unknown QS_ variable is a build warning, not a failure", async () => {
  process.env.QS_SERVR_PORT = "1";
  const lines: string[] = [];
  expect(await run(["build"], { log: (line) => lines.push(line), error: (line) => lines.push(line) }, project())).toBe(0);
  expect(lines).toContain("Warning: Unknown environment variable QS_SERVR_PORT (did you mean QS_SERVER_PORT?)");
});

test("an invalid QS_ variable fails the build naming the variable and the key", async () => {
  process.env.QS_SERVER_PORT = "abc";
  await expect(build(project())).rejects.toThrow('Invalid QS_SERVER_PORT (server.port): expected an integer between 1 and 65535, got "abc"');
});

test("the generated server starts and logs the warning once", async () => {
  const root = project();
  await build(root);
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  const child = Bun.spawn(["bun", join(root, ".generated/server.ts")], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "development", QS_SERVER_PORT: String(port), QS_SERVR_PORT: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  let output = "";
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  const read = (async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      output += decoder.decode(chunk.value, { stream: true });
    }
  })();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !(output.includes(`listening on http://localhost:${port}`) && output.includes("config.warning"))) await Bun.sleep(50);
  child.kill();
  await child.exited;
  await read.catch(() => undefined);
  expect(output).toContain(`quickservice listening on http://localhost:${port}`);
  const warnings = output.split("\n").filter((line) => line.includes('"config.warning"')).map((line) => JSON.parse(line) as { warning: string });
  expect(warnings.map((entry) => entry.warning)).toEqual(["Unknown environment variable QS_SERVR_PORT (did you mean QS_SERVER_PORT?)"]);
}, 30_000);
