import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setSamplingRandom, type ErrorReport } from "@quickservicets/core";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";
import { build } from "./build.ts";

const LOGGER = `logger: {
    info: (entry: object) => void ((globalThis as any).customLogs ??= []).push(entry),
    warn: (entry: object) => void ((globalThis as any).customLogs ??= []).push(entry),
    error: (entry: object) => void ((globalThis as any).customLogs ??= []).push(entry),
  }`;
const config = (errors: string, extra = "") => `import { defineConfig, memoryAdapter, HttpError } from "@quickservicets/core";
import { memoryReporter } from "./reporters.ts";
export default defineConfig({ database: memoryAdapter(), errors: ${errors}, ${LOGGER}${extra ? `, ${extra}` : ""} });
`;
const REPORTERS = `import type { ErrorReport } from "@quickservicets/core";
export const memoryReporter = { report: (report: ErrorReport) => void ((globalThis as any).customReports ??= []).push(report) };
`;
/** A project feature that sets the request's tenant from the x-plan header. */
const TENANT = `import { defineFeature } from "@quickservicets/core";
export default defineFeature({
  key: "tenancy",
  middleware: [{ stage: "handler", run: (req, _res, next) => { const plan = req.headers.get("x-plan"); if (plan) (req as { tenant?: unknown }).tenant = { id: "t1", plan }; return next(); } }],
});
`;
const FILES = {
  "reporters.ts": REPORTERS,
  "features/tenancy/index.ts": TENANT,
  "endpoints/boom/get.ts": 'export default () => { throw new Error("boom"); };\n',
  "endpoints/abort/get.ts": 'export default () => { const error = new Error("aborted"); error.name = "AbortError"; throw error; };\n',
  "endpoints/type/get.ts": 'export default () => { throw new TypeError("bad type"); };\n',
  "endpoints/busy/get.ts": 'import { HttpError } from "@quickservicets/core";\nexport default () => { throw new HttpError(503, "busy"); };\n',
  "endpoints/quiet/get.ts": '/** @report off */\nexport default () => { throw new Error("quiet"); };\n',
};
const reports = () => ((globalThis as { customReports?: ErrorReport[] }).customReports ??= []);
const logs = () => ((globalThis as { customLogs?: Record<string, unknown>[] }).customLogs ??= []);
afterEach(() => {
  reports().length = 0;
  logs().length = 0;
  setSamplingRandom(undefined);
});
const settle = async (count: number) => {
  for (let tries = 0; tries < 100 && reports().length < count; tries++) await Bun.sleep(5);
};

describe("variables and sampling", () => {
  test("QS_ERRORS_RELEASE puts the release in every report; QS_ERRORS_SAMPLE_RATE=abc fails startup", async () => {
    const service = await startTestService({ files: { ...FILES, "quickservicets.config.ts": config("{ reporter: memoryReporter }") }, env: { QS_ERRORS_RELEASE: "1.4.2" } });
    try {
      await service.fetch("/boom");
      expect(reports().map((report) => report.release)).toEqual(["1.4.2"]);
    } finally {
      await service.stop();
    }
    await expect(startTestService({ files: { ...FILES, "quickservicets.config.ts": config("{ reporter: memoryReporter }") }, env: { QS_ERRORS_SAMPLE_RATE: "abc" } })).rejects.toThrow("QS_ERRORS_SAMPLE_RATE");
  });

  test("sampleRate 0 sends no request report, while a startup failure is still reported", async () => {
    setSamplingRandom(() => 0.5);
    const service = await startTestService({ files: { ...FILES, "quickservicets.config.ts": config("{ reporter: memoryReporter, sampleRate: 0 }") } });
    try {
      await service.fetch("/boom");
      await Bun.sleep(10);
      expect(reports()).toEqual([]);
    } finally {
      await service.stop();
    }
    const { reportStartupFailure } = await import("@quickservicets/core");
    const started = await startTestService({ files: { ...FILES, "quickservicets.config.ts": config("{ reporter: memoryReporter, sampleRate: 0 }") } });
    try {
      await reportStartupFailure(new Error("database down"), { phase: "connect" });
      expect(reports().map((report) => [report.kind, report.tags.phase])).toEqual([["startup", "connect"]]);
    } finally {
      await started.stop();
    }
  });
});

describe("ignore and the tag", () => {
  test('ignore: ["AbortError", "503"] drops those and keeps a TypeError', async () => {
    const service = await startTestService({ files: { ...FILES, "quickservicets.config.ts": config('{ reporter: memoryReporter, ignore: ["AbortError", "503"] }') } });
    try {
      for (const path of ["/abort", "/busy", "/type"]) await service.fetch(path);
      expect(reports().map((report) => report.error.name)).toEqual(["TypeError"]);
    } finally {
      await service.stop();
    }
  });

  test("@report off stops an endpoint's reports and it still answers 500; other options fail the build", async () => {
    const service = await startTestService({ files: { ...FILES, "quickservicets.config.ts": config("{ reporter: memoryReporter }") } });
    try {
      expect((await service.fetch("/quiet")).status).toBe(500);
      expect(reports()).toEqual([]);
    } finally {
      await service.stop();
    }
    const invalid = createLinkedProject({ ...FILES, "quickservicets.config.ts": config("{}"), "endpoints/quiet/get.ts": "/** @report level=high */\nexport default () => ({});\n" });
    await expect(build(invalid)).rejects.toThrow("endpoints/quiet/get.ts: invalid @report: unknown option level");
  });

  test("@report sampleRate on an endpoint sets its rate", async () => {
    setSamplingRandom(() => 0.5);
    const service = await startTestService({ files: { ...FILES, "quickservicets.config.ts": config("{ reporter: memoryReporter }"), "endpoints/sampled/get.ts": '/** @report sampleRate=0.1 */\nexport default () => { throw new Error("sampled"); };\n' } });
    try {
      await service.fetch("/sampled");
      await service.fetch("/boom");
      expect(reports().map((report) => report.error.message)).toEqual(["boom"]);
    } finally {
      await service.stop();
    }
  });
});

describe("per-request tags and beforeReport", () => {
  test("a tags function adds the plan to request reports; one that throws keeps the request going and logs error.tags.failed", async () => {
    const service = await startTestService({ files: { ...FILES, "quickservicets.config.ts": config('{ reporter: memoryReporter, tags: ({ tenant }) => ({ plan: (tenant as { plan?: string } | undefined)?.plan ?? "free" }) }', "tenancy: {}") } });
    try {
      await service.fetch("/boom", { headers: { "x-plan": "pro" } });
      await service.fetch("/boom");
      expect(reports().map((report) => report.tags.plan)).toEqual(["pro", "free"]);
    } finally {
      await service.stop();
    }
    reports().length = 0;
    const throwing = await startTestService({ files: { ...FILES, "quickservicets.config.ts": config('{ reporter: memoryReporter, tags: () => { throw new Error("no tags"); } }') } });
    try {
      expect((await throwing.fetch("/boom")).status).toBe(500);
      expect(reports().map((report) => report.tags)).toEqual([{}]);
      expect(logs().some((entry) => entry.message === "error.tags.failed")).toBe(true);
    } finally {
      await throwing.stop();
    }
  });

  test("beforeReport changes or drops reports; a feature's hook runs after the config's", async () => {
    const feature = `import { defineFeature } from "@quickservicets/core";
export default defineFeature({
  key: "redactor",
  requires: ["errors"],
  setup(ctx) {
    ctx.feature("errors").beforeReport((report) => report && { ...report, tags: { ...report.tags, order: (report.tags.order ?? "") + "+feature" } });
  },
});
`;
    const service = await startTestService({
      files: {
        ...FILES,
        "features/redactor/index.ts": feature,
        "quickservicets.config.ts": config('{ reporter: memoryReporter, beforeReport: (report) => (report?.error.name === "TypeError" ? null : report && { ...report, request: report.request && { ...report.request, query: {} }, tags: { ...report.tags, order: "config" } }) }', "redactor: {}"),
      },
    });
    try {
      await service.fetch("/boom?page=2");
      await service.fetch("/type");
      await settle(1);
      await Bun.sleep(10);
      expect(reports().map((report) => [report.error.message, report.request!.query, report.tags.order])).toEqual([["boom", {}, "config+feature"]]);
    } finally {
      await service.stop();
    }
  });
});

describe("the reference page", () => {
  test("lists the options with their variables and the @report tag", () => {
    const page = readFileSync(join(import.meta.dir, "../../../../docs/src/content/docs/reference/features/errors.mdx"), "utf8");
    for (const text of ["`errors.reporter`", "`errors.release`", "`QS_ERRORS_RELEASE`", "`errors.tags.<name>`", "`errors.jobs`", "`errors.sampleRate`", "`errors.ignore`", "`errors.beforeReport`", "### `@report`", "### `addReporter`", "### `beforeReport`"]) {
      expect(page).toContain(text);
    }
  });
});
