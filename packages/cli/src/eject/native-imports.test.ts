import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { nativeImportProblems } from "./native-imports.ts";

/** A copy of the core's layout: `<root>/repository.ts` and natives in `<root>/features/`. */
function layout(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "quickservice-natives-"));
  for (const [path, content] of Object.entries({ "repository.ts": "export const x = 1;\n", "features/public.ts": 'export * from "../repository.ts";\n', ...files })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return join(root, "features");
}

describe("the native import rule", () => {
  test("every native of the core imports the core only from features/public.ts", () => {
    expect(nativeImportProblems()).toEqual([]);
  });

  test("a native importing another core file fails; one importing ../public.ts passes", () => {
    const bad = layout({ "features/audit/index.ts": 'import { x } from "../../repository.ts";\nexport default x;\n' });
    expect(nativeImportProblems(bad)).toEqual(["audit/index.ts: imports ../../repository.ts; natives import the core only from ../public.ts"]);
    const good = layout({
      "features/audit/index.ts": 'import { x } from "../public.ts";\nimport { y } from "./lib/y.ts";\nimport { join } from "node:path";\nexport default [x, y, join];\n',
      "features/audit/lib/y.ts": 'export { x as y } from "../../public";\n',
    });
    expect(nativeImportProblems(good)).toEqual([]);
    const packageImport = layout({ "features/audit/index.ts": 'export { defineFeature } from "@quickservice/core";\n' });
    expect(nativeImportProblems(packageImport)).toEqual(["audit/index.ts: imports @quickservice/core; natives import the core only from ../public.ts"]);
  });
});
