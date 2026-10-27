import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { createLinkedProject } from "../testing/project.ts";
import { build } from "./build.ts";

/** The type errors of `source` in a built project, with its generated http types. */
function typeErrors(root: string, source: string): string[] {
  const check = join(root, "check.ts");
  writeFileSync(check, source);
  const program = ts.createProgram([check, join(root, ".generated/types.ts")], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    lib: ["lib.esnext.d.ts", "lib.dom.d.ts"],
    types: [],
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
  });
  return ts.getPreEmitDiagnostics(program, program.getSourceFile(check)).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
}

test("the build generates the service names, so http.service() takes the configured ones and <feature>/<name>", async () => {
  const root = createLinkedProject({
    "quickservicets.config.ts": `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), http: { services: { billing: { url: "http://billing.internal/v1" }, "the-catalog": { url: "http://catalog.internal" } } } });
`,
  });
  await build(root);
  expect(readFileSync(join(root, ".generated/types.ts"), "utf8")).toContain('"the-catalog": true;');
  const usage = `import { http } from "@quickservicets/core";
export const calls = [http.service("billing"), http.service("the-catalog"), http.service("sso/issuer"), http.service("nope")];
`;
  const errors = typeErrors(root, usage);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain('"nope"');
});
