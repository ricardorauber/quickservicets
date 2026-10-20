import { expect, test } from "bun:test";
import { join } from "node:path";

test("the repository type-checks without errors", async () => {
  const child = Bun.spawn(["bun", "run", "typecheck"], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`bun run typecheck failed:\n${stdout}${stderr}`);
  expect(code).toBe(0);
}, 300_000);
