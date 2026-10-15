import { expect, test } from "bun:test";
import packageJson from "../package.json" with { type: "json" };

test("--version prints the package version", async () => {
  const proc = Bun.spawn(["bun", `${import.meta.dir}/index.ts`, "--version"], { stdout: "pipe" });
  const output = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(output.trim()).toBe(packageJson.version);
});
