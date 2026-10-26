import { describe, expect, test } from "bun:test";
import { findUnsafeSql, formatProblem } from "./unsafe-sql.ts";

const check = (source: string, file = "packages/cli/src/example.ts") => findUnsafeSql(file, source).map(formatProblem);
const built = "unsafe() must receive literal SQL; pass values as parameters";

describe("unsafe() arguments", () => {
  test("literal SQL passes and built SQL is reported with its file and line", () => {
    const source = [
      'await sql.unsafe("select * from t where id = $1", [id]);',
      "await sql.unsafe(`select * from t`);",
      "await sql.unsafe(`select * from t where id = '${id}'`);",
      'await sql.unsafe("select * from t where id = " + id);',
      "await sql.unsafe(text, [id]);",
      'await sql["unsafe"](`select ${columns} from t`);',
      "await unsafe(text);",
      "const unsafe = sql.unsafe.bind(sql);",
      "await sql.unsafe();",
    ].join("\n");
    expect(check(source)).toEqual([
      `packages/cli/src/example.ts:3: ${built}`,
      `packages/cli/src/example.ts:4: ${built}`,
      `packages/cli/src/example.ts:5: ${built}`,
      `packages/cli/src/example.ts:6: ${built}`,
      `packages/cli/src/example.ts:9: ${built}`,
    ]);
  });

  test("a multi-line call is reported at the line of unsafe", () => {
    expect(check("const rows = await admin\n  .unsafe(\n    text,\n  );")).toEqual([`packages/cli/src/example.ts:2: ${built}`]);
  });

  test("text that only looks like a call is ignored", () => {
    expect(check('const sample = "sql.unsafe(`select ${id}`)"; // sql.unsafe(text)')).toEqual([]);
  });
});

describe("exempt folder and marker", () => {
  const interpolated = "await sql.unsafe(`select * from t where id = '${id}'`);";

  test("the adapters folder is exempt", () => {
    expect(check(interpolated, "packages/core/src/adapters/postgres.ts")).toEqual([]);
    expect(check(interpolated, "packages/core/src/testing/postgres.ts")).toHaveLength(1);
  });

  test("a marker with a reason on the line above allows the call", () => {
    expect(check(`// quickservicets-allow-unsafe: creates a test schema\n${interpolated}`)).toEqual([]);
    expect(check(`  // quickservicets-allow-unsafe: creates a test schema\n  ${interpolated}`)).toEqual([]);
  });

  test("a marker further up does not allow the call", () => {
    expect(check(`// quickservicets-allow-unsafe: creates a test schema\n\n${interpolated}`)).toEqual([`packages/cli/src/example.ts:3: ${built}`]);
  });

  test("a marker without a reason is reported and allows nothing", () => {
    expect(check(`// quickservicets-allow-unsafe:\n${interpolated}`)).toEqual([
      "packages/cli/src/example.ts:1: quickservicets-allow-unsafe needs a reason",
      `packages/cli/src/example.ts:2: ${built}`,
    ]);
    expect(check("// quickservicets-allow-unsafe:   \nconst x = 1;")).toEqual(["packages/cli/src/example.ts:1: quickservicets-allow-unsafe needs a reason"]);
  });
});
