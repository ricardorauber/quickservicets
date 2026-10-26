import { afterEach, describe, expect, test } from "bun:test";
import { startTestService, type TestService } from "@quickservicets/cli/testing";
import { createServer, maskedLogger, maskEntry, maskUrl, REQUEST_LOG, type LogEntry } from "@quickservicets/core";
import { DEFAULT_MASKED_KEYS } from "../../../core/src/features/security/masking.ts";

/** Log entries the projects' config logger writes, read by the tests. */
const LOGS = "__securityMaskingLogs";
const logs = (): LogEntry[] => ((globalThis as Record<string, unknown>)[LOGS] ??= []) as LogEntry[];
afterEach(() => {
  logs().length = 0;
});

const CONFIG = (keys = "") => `import { defineConfig, memoryAdapter, secret } from "@quickservicets/core";
const sink = ((globalThis as Record<string, unknown>).${LOGS} ??= []) as unknown[];
const write = (entry: unknown) => void sink.push(entry);
export default defineConfig({ database: memoryAdapter(), logger: { info: write, warn: write, error: write }${keys ? `, ${keys}` : ""} });
`;
const CUSTOMER = "export type Customer = {\n  name: string;\n  /** @sensitive */\n  taxId: string;\n};\n";
const LOGIN_JOB = `import { job } from "@quickservicets/core";
export default job("@daily", async ({ log }) => {
  log.info("login", { email: "a@b.c", password: "hunter2", apiKey: "k", headers: { Authorization: "Bearer x" } });
  log.info("customer", { customer: { taxId: "123" } });
  log.info("token", { token: "t" });
  return { token: "t", ok: true };
});
`;
const RUN = `import type { Endpoint } from "@quickservicets/core";
const handler: Endpoint = (_repos, req) => req.jobs.run("login");
export default handler;
`;

async function withService(files: Record<string, string>, run: (service: TestService) => Promise<void>, env?: Record<string, string>): Promise<void> {
  const service = await startTestService({ files, ...(env ? { env } : {}) });
  try {
    await run(service);
  } finally {
    await service.stop();
  }
}

/** Runs the login job through an endpoint and returns its stored run. */
async function runLoginJob(service: TestService): Promise<{ status: string; logs: { message: string; fields?: Record<string, unknown> }[]; result: unknown }> {
  const { runId } = (await (await service.fetch("/run", { method: "POST" })).json()) as { runId: string };
  const runs = (service.repos as unknown as { jobRuns: { findById(id: string): Promise<{ status: string; logs: never[]; result: unknown } | null> } }).jobRuns;
  for (let attempt = 0; attempt < 200; attempt++) {
    const run = await runs.findById(runId);
    if (run && run.status !== "running") return run;
    await Bun.sleep(5);
  }
  throw new Error("the job did not finish");
}

describe("key matching", () => {
  test("names containing a key match, ignoring case, dashes and underscores", () => {
    const rules = { keys: DEFAULT_MASKED_KEYS };
    expect(maskEntry({ Password: "a", "x-api-key": "b", session_token: "c", Set_Cookie: "d", privateKeyPem: "e", cvv2: "f", name: "g" }, rules)).toEqual({
      Password: "[secret]",
      "x-api-key": "[secret]",
      session_token: "[secret]",
      Set_Cookie: "[secret]",
      privateKeyPem: "[secret]",
      cvv2: "[secret]",
      name: "g",
    });
    expect(DEFAULT_MASKED_KEYS).toEqual(["password", "passwd", "secret", "token", "apikey", "authorization", "cookie", "setcookie", "privatekey", "clientsecret", "signature", "creditcard", "cardnumber", "cvv"]);
  });
});

describe("maskEntry", () => {
  test("depth, immutability, sensitive names and secret values", () => {
    const rules = { keys: ["password"], sensitive: ["taxId"], secrets: ["sk_live_1234567890", "short"] };
    const at = new Date(0);
    const input = { at, nested: { taxId: "1", list: [{ password: "p" }, "uses sk_live_1234567890 here", 3] }, short: "short" };
    const masked = maskEntry(input, rules);
    expect(masked).toEqual({ at, nested: { taxId: "[sensitive]", list: [{ password: "[secret]" }, "uses [secret] here", 3] }, short: "short" });
    expect(masked.at).toBe(at);
    expect(input.nested.list[0]).toEqual({ password: "p" });
    const plain = { a: 1, b: { c: ["x"] } };
    expect(maskEntry(plain, rules)).toBe(plain);
    // Below depth 8 nothing is walked.
    let deep: Record<string, unknown> = { password: "p" };
    for (let level = 0; level < 9; level++) deep = { child: deep };
    expect(maskEntry(deep, rules)).toBe(deep);
  });
});

describe("maskUrl", () => {
  test("user information and secret query parameters", () => {
    expect(maskUrl("https://u:p@api.example/x?token=abc&page=2", { keys: DEFAULT_MASKED_KEYS })).toBe("https://[secret]@api.example/x?token=[secret]&page=2");
    expect(maskUrl("/callback?code=1&client_secret=s#top", { keys: DEFAULT_MASKED_KEYS })).toBe("/callback?code=1&client_secret=[secret]#top");
  });
});

describe("the service", () => {
  test("a job's log entries and its stored run are masked, keeping other values", async () => {
    await withService({ "quickservicets.config.ts": CONFIG(), "entities/Customer.ts": CUSTOMER, "jobs/login.ts": LOGIN_JOB, "endpoints/run/post.ts": RUN }, async (service) => {
      const run = await runLoginJob(service);
      expect(run.status).toBe("success");
      const login = logs().find((entry) => entry.message === "login")!;
      expect(login).toMatchObject({ email: "a@b.c", password: "[secret]", apiKey: "[secret]", headers: { Authorization: "[secret]" } });
      expect(logs().find((entry) => entry.message === "customer")).toMatchObject({ customer: { taxId: "[sensitive]" } });
      expect(run.logs.find((line) => line.message === "token")!.fields).toEqual({ token: "[secret]" });
      expect(run.logs.find((line) => line.message === "login")!.fields).toMatchObject({ password: "[secret]", email: "a@b.c" });
      expect(run.result).toEqual({ token: "[secret]", ok: true });
    });
  });

  test("@sensitive does not change API responses", async () => {
    await withService({ "quickservicets.config.ts": CONFIG(), "entities/Customer.ts": CUSTOMER }, async (service) => {
      const created = (await (await service.fetch("/customers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Ada", taxId: "123" }) })).json()) as { id: string };
      expect(((await (await service.fetch(`/customers/${created.id}`)).json()) as { taxId: string }).taxId).toBe("123");
    });
  });

  test("a secret variable is masked in the logged error and in the development response", async () => {
    const failing = `import { env, type Endpoint } from "@quickservicets/core";\nconst handler: Endpoint = () => { throw new Error(\`charge failed with \${(env as { STRIPE_KEY: string }).STRIPE_KEY}\`); };\nexport default handler;\n`;
    const files = { "quickservicets.config.ts": CONFIG("env: { STRIPE_KEY: secret() }"), "endpoints/charge/post.ts": failing };
    await withService(
      files,
      async (service) => {
        const response = await service.fetch("/charge", { method: "POST" });
        expect(response.status).toBe(500);
        const body = JSON.stringify(await response.json());
        expect(body).not.toContain("sk_live_1234567890");
        expect(body).toContain("charge failed with [secret]");
        const logged = JSON.stringify(logs().filter((entry) => entry.level === undefined && (entry as { error?: unknown }).error));
        expect(logged).toContain("charge failed with [secret]");
        expect(JSON.stringify(logs())).not.toContain("sk_live_1234567890");
      },
      { STRIPE_KEY: "sk_live_1234567890" },
    );
  });

  test("masking keys can be replaced, and masking: false logs values unchanged", async () => {
    const files = (security: string) => ({ "quickservicets.config.ts": CONFIG(`security: ${security}`), "jobs/login.ts": 'import { job } from "@quickservicets/core";\nexport default job("@daily", async ({ log }) => { log.info("pin", { userPin: "1234", password: "hunter2" }); });\n', "endpoints/run/post.ts": RUN });
    await withService(files('{ masking: { keys: ["pin"] } }'), async (service) => {
      await runLoginJob(service);
      expect(logs().find((entry) => entry.message === "pin")).toMatchObject({ userPin: "[secret]", password: "hunter2" });
    });
    logs().length = 0;
    await withService(files("{ masking: false }"), async (service) => {
      await runLoginJob(service);
      expect(logs().find((entry) => entry.message === "pin")).toMatchObject({ userPin: "1234", password: "hunter2" });
    });
  });

  test("an entry without matches stays the same object, and request log entries are not walked", async () => {
    const seen: unknown[] = [];
    const walked: unknown[] = [];
    const masker = { entry: <T>(value: T) => (walked.push(value), value), text: (text: string) => text };
    const sink = { info: (entry: LogEntry) => void seen.push(entry), warn() {}, error() {} };
    const server = createServer({ routes: [{ method: "GET", path: "/ok", handler: () => ({ ok: true }) }], repos: {}, config: { production: false, logger: maskedLogger(sink, masker) } });
    await server.fetch(new Request("http://localhost/ok"));
    expect(seen).toHaveLength(1);
    expect((seen[0] as Record<symbol, unknown>)[REQUEST_LOG]).toBe(true);
    expect(walked).toEqual([]);
    const entry = { message: "plain", count: 1 };
    expect(maskEntry(entry, { keys: DEFAULT_MASKED_KEYS })).toBe(entry);
  });
});
