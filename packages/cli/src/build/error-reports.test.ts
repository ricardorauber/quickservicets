import { afterEach, describe, expect, test } from "bun:test";
import { reportError, type ErrorReport } from "@quickservicets/core";
import { startTestService } from "../testing/service.ts";

const LOGGER = `logger: {
    info: (entry: object) => void ((globalThis as any).errorLogs ??= []).push(entry),
    warn: (entry: object) => void ((globalThis as any).errorLogs ??= []).push(entry),
    error: (entry: object) => void ((globalThis as any).errorLogs ??= []).push(entry),
  }`;
const config = (errors: string | undefined, extra = "") => `import { defineConfig, memoryAdapter, HttpError } from "@quickservicets/core";
import { memoryReporter, throwingReporter, slowReporter } from "./reporters.ts";
export default defineConfig({ database: memoryAdapter(), ${errors === undefined ? "" : `errors: ${errors}, `}${LOGGER}${extra ? `, ${extra}` : ""} });
`;
const REPORTERS = `import type { ErrorReport } from "@quickservicets/core";
export const received: ErrorReport[] = ((globalThis as any).receivedReports = []);
export const memoryReporter = { report: (report: ErrorReport) => void received.push(report) };
export const throwingReporter = { report: () => { throw new Error("reporter down"); } };
export const slowReporter = { report: () => new Promise<void>(() => undefined) };
`;
/** A project feature that signs requests in as the user of the x-user header. */
const SIGN_IN = `import { defineFeature } from "@quickservicets/core";
export default defineFeature({
  key: "signin",
  middleware: [{ stage: "handler", run: (req, _res, next) => { const id = req.headers.get("x-user"); if (id) (req as { user?: unknown }).user = { id }; return next(); } }],
});
`;
const FILES = {
  "quickservicets.config.ts": config("{}"),
  "reporters.ts": REPORTERS,
  "features/signin/index.ts": SIGN_IN,
  "endpoints/boom/get.ts": 'export default () => { throw new Error("boom"); };\n',
  "endpoints/missing/get.ts": 'import { HttpError } from "@quickservicets/core";\nexport default () => { throw new HttpError(404, "Nothing here"); };\n',
  "endpoints/unavailable/get.ts": 'import { HttpError } from "@quickservicets/core";\nexport default () => { throw new HttpError(503, "Try later"); };\n',
  "endpoints/manual/post.ts": 'import { reportError } from "@quickservicets/core";\nexport default () => { reportError(new Error("x"), { tags: { area: "billing" } }); return { ok: true }; };\n',
};
const withSignIn = (errors: string) => config(errors, "signin: {}");
const logs = () => ((globalThis as { errorLogs?: Record<string, unknown>[] }).errorLogs ??= []);
const received = () => ((globalThis as { receivedReports?: ErrorReport[] }).receivedReports ??= []);
afterEach(() => {
  logs().length = 0;
  received().length = 0;
});

describe("request reports", () => {
  test("a thrown Error answers 500 as before and logs one error.report with the request", async () => {
    const service = await startTestService({ files: FILES });
    try {
      const response = await service.fetch("/boom");
      expect(response.status).toBe(500);
      const reports = logs().filter((entry) => entry.message === "error.report");
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ kind: "request", environment: "development", error: { name: "Error", message: "boom" }, request: { route: "/boom", id: response.headers.get("x-request-id"), method: "GET", path: "/boom" } });
      expect(logs().some((entry) => entry.requestId === response.headers.get("x-request-id") && (entry.error as { message?: string })?.message === "boom" && entry.message === undefined)).toBe(true);
    } finally {
      await service.stop();
    }
  });

  test("an HttpError below 500 sends no report, a 503 sends one", async () => {
    const service = await startTestService({ files: { ...FILES, "quickservicets.config.ts": config("{ reporter: memoryReporter }") } });
    try {
      expect((await service.fetch("/missing")).status).toBe(404);
      expect(received()).toEqual([]);
      expect((await service.fetch("/unavailable")).status).toBe(503);
      expect(received().map((report) => report.error.message)).toEqual(["Try later"]);
    } finally {
      await service.stop();
    }
  });

  test("a report holds only three headers, masks secret-looking query values, and has the user", async () => {
    const service = await startTestService({ files: { ...FILES, "quickservicets.config.ts": withSignIn("{ reporter: memoryReporter }") } });
    try {
      await service.fetch("/boom?token=abc&page=2", {
        headers: { authorization: "Bearer secret-token-value", cookie: "session=abc", "x-api-key": "k", "user-agent": "tests", "content-type": "text/plain", referer: "https://example.com", "x-user": "u1" },
      });
      const [report] = received();
      expect(report!.request!.headers).toEqual({ "user-agent": "tests", "content-type": "text/plain", referer: "https://example.com" });
      expect(report!.request!.query).toEqual({ token: "[secret]", page: "2" });
      expect(report!.user).toEqual({ id: "u1" });
      expect(JSON.stringify(report)).not.toContain("secret-token-value");
    } finally {
      await service.stop();
    }
  });
});

describe("manual reports", () => {
  test("reportError sends a manual report with its tags and the release; without the native it does nothing", async () => {
    const service = await startTestService({ files: { ...FILES, "quickservicets.config.ts": config('{ reporter: memoryReporter, release: "1.4.2", tags: { region: "eu" } }') } });
    try {
      await service.fetch("/manual", { method: "POST" });
      expect(received()).toMatchObject([{ kind: "manual", error: { message: "x" }, tags: { region: "eu", area: "billing" }, release: "1.4.2" }]);
    } finally {
      await service.stop();
    }
    received().length = 0;
    const without = await startTestService({ files: { ...FILES, "quickservicets.config.ts": config(undefined) } });
    try {
      expect((await without.fetch("/manual", { method: "POST" })).status).toBe(200);
      reportError(new Error("ignored"));
      expect(received()).toEqual([]);
    } finally {
      await without.stop();
    }
  });
});

describe("reporter failures", () => {
  test("a throwing reporter is logged and the next still receives the report; a reporter that never resolves does not delay the response", async () => {
    const service = await startTestService({ files: { ...FILES, "quickservicets.config.ts": config("{ reporter: [slowReporter, throwingReporter, memoryReporter] }", "lifecycle: { stopTimeout: \"1s\" }") } });
    try {
      const response = await service.fetch("/boom");
      expect(response.status).toBe(500);
      expect(received()).toHaveLength(1);
      expect(logs()).toContainEqual(expect.objectContaining({ message: "error.report.failed", reporter: 1, error: { message: "reporter down" } }));
    } finally {
      await service.stop();
    }
  });
});

describe("the feature API and the disabled path", () => {
  test("a feature's reporter receives reports after the configured ones", async () => {
    const feature = `import { defineFeature, type ErrorReport } from "@quickservicets/core";
export default defineFeature({
  key: "tracker",
  requires: ["errors"],
  setup(ctx) {
    ctx.feature("errors").addReporter({ report: (report: ErrorReport) => void ((globalThis as any).receivedReports ??= []).push({ ...report, by: "feature" }) });
  },
});
`;
    const service = await startTestService({ files: { ...FILES, "features/tracker/index.ts": feature, "quickservicets.config.ts": config("{ reporter: memoryReporter }", "tracker: {}") } });
    try {
      await service.fetch("/boom");
      expect(received().map((report) => (report as ErrorReport & { by?: string }).by ?? "config")).toEqual(["config", "feature"]);
    } finally {
      await service.stop();
    }
  });

  test("without errors no error middleware is registered and nothing is reported", async () => {
    const { createFeatureLifecycle, resolveConfig, memoryAdapter } = await import("@quickservicets/core");
    const resolved = resolveConfig({ database: memoryAdapter() }, {});
    const lifecycle = createFeatureLifecycle({ features: resolved.features, config: resolved, models: [], worker: { index: 0, count: 1, runsScheduledWork: true } });
    await lifecycle.setup();
    expect(lifecycle.middleware.filter((entry) => entry.middleware.stage === "error")).toEqual([]);
    await lifecycle.stop();
    const service = await startTestService({ files: { ...FILES, "quickservicets.config.ts": config(undefined) } });
    try {
      expect((await service.fetch("/boom")).status).toBe(500);
      expect(logs().some((entry) => entry.message === "error.report")).toBe(false);
    } finally {
      await service.stop();
    }
  });
});
