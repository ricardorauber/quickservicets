import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { createLinkedProject } from "../testing/project.ts";
import { eject } from "./eject.ts";

const example = join(import.meta.dir, "../../../../examples/minimal/security");

/** The example's files: config, entities, endpoints, features and its mTLS test. */
function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const file of ["quickservicets.config.ts", "package.json", "tsconfig.json", "tests/mtls.test.ts"]) files[file] = readFileSync(join(example, file), "utf8");
  for (const dir of ["entities", "endpoints", "features"]) {
    for (const entry of readdirSync(join(example, dir), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files[relative(example, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), "utf8");
    }
  }
  return files;
}

test("quickservicets eject security turns the native into features/security/ and the example's mTLS test passes against it", async () => {
  const root = createLinkedProject(exampleFiles());
  symlinkSync(join(import.meta.dir, "../.."), join(root, "node_modules/@quickservicets/cli"), "dir");
  const lines = await eject(root, "security");
  expect(lines).toContain("features/security/ now replaces the security native.");
  expect(existsSync(join(root, "features/security/mtls.ts"))).toBe(true);
  const run = Bun.spawnSync(["bun", "test", "tests/mtls.test.ts"], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, NODE_ENV: "test" } });
  const output = run.stderr.toString();
  expect(output).toContain(" 5 pass");
  expect(run.exitCode).toBe(0);
}, 120_000);
