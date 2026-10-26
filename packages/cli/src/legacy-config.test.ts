import { expect, test } from "bun:test";
import { LEGACY_CONFIG_FILE } from "@quickservicets/core";
import { run } from "./run.ts";
import { createLinkedProject, createProject } from "./testing/project.ts";

const config = 'import { defineConfig, memoryAdapter } from "@quickservicets/core";\nexport default defineConfig({ database: memoryAdapter() });\n';

const capture = async (args: string[], root: string) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, { log: (line) => out.push(line), error: (line) => err.push(line) }, root);
  return { code, out, err };
};

test("a project with only the config file under the previous name is told to rename it, with exit code 3", async () => {
  const root = createProject({ [LEGACY_CONFIG_FILE]: config });
  for (const args of [["build"], ["migrate"], ["help"], ["job", "list"], ["unknown"]]) {
    expect(await capture(args, root)).toEqual({ code: 3, out: [], err: [`Rename ${LEGACY_CONFIG_FILE} to quickservicets.config.ts`] });
  }
});

test("the old config file is ignored once quickservicets.config.ts exists", async () => {
  const root = createLinkedProject({ [LEGACY_CONFIG_FILE]: config, "quickservicets.config.ts": config });
  const { code, err } = await capture(["help"], root);
  expect(code).toBe(0);
  expect(err).toEqual([]);
});
