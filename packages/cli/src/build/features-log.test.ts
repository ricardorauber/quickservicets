import { expect, test } from "bun:test";
import { join } from "node:path";
import { createLinkedProject, MEMORY_CONFIG } from "../testing/project.ts";
import { build } from "./build.ts";

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

test("the generated server logs the enabled features at startup", async () => {
  const root = createLinkedProject({ "quickservice.config.ts": MEMORY_CONFIG, "entities/User.ts": "export type User = { email: string };\n" });
  await build(root);
  const child = Bun.spawn(["bun", join(root, ".generated/server.ts")], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "development", PORT: String(freePort()) },
    stdout: "pipe",
    stderr: "pipe",
  });
  let output = "";
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + 10_000;
  const read = (async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      output += decoder.decode(chunk.value, { stream: true });
    }
  })();
  while (Date.now() < deadline && !(output.includes("quickservice listening") && output.includes("features.enabled"))) await Bun.sleep(50);
  child.kill();
  await child.exited;
  await read.catch(() => undefined);
  const entries = output
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as { message?: string; features?: unknown });
  expect(entries.filter((entry) => entry.message === "features.enabled")).toEqual([expect.objectContaining({ message: "features.enabled", features: [] })]);
}, 30_000);
