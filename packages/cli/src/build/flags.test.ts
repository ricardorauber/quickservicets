import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";
import { build } from "./build.ts";

const config = (flags: string | undefined, extra = "") => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), signin: {}${flags === undefined ? "" : `, flags: ${flags}`}${extra ? `, ${extra}` : ""} });
`;
/** A project feature that signs requests in as the user of x-user and the tenant of x-tenant. */
const SIGN_IN = `import { defineFeature } from "@quickservicets/core";
export default defineFeature({
  key: "signin",
  middleware: [{ stage: "handler", order: -60000, run: (req, _res, next) => {
    const user = req.headers.get("x-user");
    const tenant = req.headers.get("x-tenant");
    if (user) (req as { user?: unknown }).user = { id: user };
    if (tenant) (req as { tenant?: unknown }).tenant = { id: tenant };
    return next();
  } }],
});
`;
const RULES = '{ rules: { "checkout-v2": { users: ["u1"] }, "dark-mode": true, "old-search": false, rollout: { percentage: 30 }, acme: { tenants: ["acme"] }, "acme-off": { tenants: ["acme"], enabled: false } } }';
const FILES = {
  "quickservicets.config.ts": config(RULES),
  "features/signin/index.ts": SIGN_IN,
  "endpoints/flags/get.ts": `import type { ServiceRequest } from "@quickservicets/core";
export default (_repos: unknown, req: ServiceRequest) => ({
  checkout: req.flags?.on("checkout-v2"),
  oldSearchOff: req.flags?.off("old-search"),
  rollout: req.flags?.on("rollout"),
  acme: req.flags?.on("acme"),
  acmeOff: req.flags?.on("acme-off"),
  all: req.flags?.all(),
  present: req.flags !== undefined,
});
`,
};
type Answer = { checkout: boolean; oldSearchOff: boolean; rollout: boolean; acme: boolean; acmeOff: boolean; all: Record<string, boolean>; present: boolean };
const read = async (service: { fetch(path: string, init?: RequestInit): Promise<Response> }, headers: Record<string, string> = {}) => (await (await service.fetch("/flags", { headers })).json()) as Answer;

describe("req.flags", () => {
  test("users, true, false and all() from the config's rules", async () => {
    const service = await startTestService({ files: FILES });
    try {
      const u1 = await read(service, { "x-user": "u1" });
      expect([u1.checkout, u1.oldSearchOff, u1.all["dark-mode"], u1.all["old-search"]]).toEqual([true, true, true, false]);
      expect(Object.keys(u1.all).sort()).toEqual(["acme", "acme-off", "checkout-v2", "dark-mode", "old-search", "rollout"]);
      expect((await read(service, { "x-user": "u2" })).checkout).toBe(false);
    } finally {
      await service.stop();
    }
  });

  test("tenants, disabled rules, and a percentage that gives one user the same answer on two instances and is off for anonymous requests", async () => {
    const first = await startTestService({ files: FILES });
    const second = await startTestService({ files: FILES });
    try {
      expect([(await read(first, { "x-tenant": "acme" })).acme, (await read(first, { "x-tenant": "globex" })).acme, (await read(first, { "x-tenant": "acme" })).acmeOff]).toEqual([true, false, false]);
      for (const user of ["a", "b", "c", "d", "e"]) expect((await read(first, { "x-user": user })).rollout).toBe((await read(second, { "x-user": user })).rollout);
      expect((await read(first)).rollout).toBe(false);
    } finally {
      await first.stop();
      await second.stop();
    }
  });

  test("a project feature reads isOn through the feature API; without flags req.flags is undefined", async () => {
    const reader = `import { defineFeature } from "@quickservicets/core";
export default defineFeature({ key: "reader", requires: ["flags"], setup(ctx) { (globalThis as any).flagRead = ctx.feature("flags").isOn("checkout-v2", { user: { id: "u1" } }); } });
`;
    const service = await startTestService({ files: { ...FILES, "features/reader/index.ts": reader, "quickservicets.config.ts": config(RULES, "reader: {}") } });
    try {
      expect((globalThis as { flagRead?: boolean }).flagRead).toBe(true);
    } finally {
      await service.stop();
    }
    const without = await startTestService({ files: { ...FILES, "quickservicets.config.ts": config(undefined) } });
    try {
      expect((await read(without)).present).toBe(false);
    } finally {
      await without.stop();
    }
  });
});

describe("generated types", () => {
  function typeErrors(root: string, source: string): string[] {
    const check = join(root, "check.ts");
    writeFileSync(check, source);
    const program = ts.createProgram([check, join(root, ".generated/flags/types.ts")], {
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
  const usage = 'import type { ServiceRequest } from "@quickservicets/core";\nexport const read = (req: ServiceRequest) => [req.flags!.on("checkout-v2"), req.flags!.on("nope")];\n';

  test("with the config source on() takes the rules' names; with the database source any name", async () => {
    const root = createLinkedProject(FILES);
    await build(root);
    const errors = typeErrors(root, usage);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"nope"');
    const database = createLinkedProject({ ...FILES, "quickservicets.config.ts": config('{ source: "database", rules: { "checkout-v2": true } }') });
    await build(database);
    expect(typeErrors(database, usage)).toEqual([]);
  });
});
