import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { startTestService, type TestService } from "@quickservice/cli/testing";

const root = join(import.meta.dir, "..");
/** Where the tests' logger writes the service's log entries. */
const SINK = "__securityExampleLogs";

/** The example's own files, as `startTestService` takes them, with a config logger the tests read. */
function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const dir of ["entities", "endpoints", "features"]) {
    for (const entry of readdirSync(join(root, dir), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files[relative(root, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), "utf8");
    }
  }
  const config = readFileSync(join(root, "quickservice.config.ts"), "utf8");
  const logger = `logger: { info: (entry) => void ((globalThis as Record<string, unknown>).${SINK} as unknown[]).push(entry), warn() {}, error() {} },\n  audit: {},`;
  files["quickservice.config.ts"] = config.replace("audit: {},", logger);
  return files;
}

const logs = () => ((globalThis as Record<string, unknown>)[SINK] ??= []) as Record<string, unknown>[];
afterEach(() => {
  logs().length = 0;
});

async function withService(run: (service: TestService) => Promise<void>): Promise<void> {
  logs();
  const service = await startTestService({ files: exampleFiles() });
  try {
    await run(service);
  } finally {
    await service.stop();
  }
}

const json = (body: unknown, peer = "203.0.113.5") => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), peer });

test("every response carries the default security headers", async () => {
  await withService(async (service) => {
    const response = await service.fetch("/posts", { peer: "203.0.113.5" });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(response.headers.get("ratelimit-limit")).toBe("1000");
  });
});

test("a preflight from the browser app is answered, one from another origin is refused", async () => {
  await withService(async (service) => {
    const preflight = (origin: string) => service.fetch("/posts", { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
    const allowed = await preflight("http://localhost:5173");
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const refused = await preflight("https://evil.example");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: { code: "FORBIDDEN", message: "Origin not allowed" } });
  });
});

test("the sixth login in a minute answers 429 with retry-after", async () => {
  await withService(async (service) => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt++) statuses.push((await service.fetch("/login", json({ email: "ada@example.com", password: "guess" }))).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    const refused = await service.fetch("/login", json({ email: "ada@example.com", password: "guess" }));
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });
});

test("the admin stats refuse a public address and answer the private network", async () => {
  await withService(async (service) => {
    expect((await service.fetch("/admin/stats", { peer: "203.0.113.5" })).status).toBe(403);
    expect(await (await service.fetch("/admin/stats", { peer: "10.0.0.7" })).json()).toEqual({ posts: 0, customers: 0 });
  });
});

test("a 2 MB JSON body is refused with 413", async () => {
  await withService(async (service) => {
    const body = JSON.stringify({ title: "x".repeat(2 * 1024 * 1024) });
    const response = await service.fetch("/posts", { method: "POST", headers: { "content-type": "application/json", "content-length": String(body.length) }, body, peer: "203.0.113.5" });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body is larger than 1MB" } });
  });
});

test("a logged customer shows its tax id as [sensitive], while the API returns it", async () => {
  await withService(async (service) => {
    const created = (await (await service.fetch("/customers", json({ name: "Ada", taxId: "123-45-6789" }))).json()) as { id: string; taxId: string };
    expect(created.taxId).toBe("123-45-6789");
    const entry = logs().find((logged) => logged.message === "customer.created") as { customer: { name: string; taxId: string } };
    expect(entry.customer).toMatchObject({ name: "Ada", taxId: "[sensitive]" });
    expect(JSON.stringify(logs())).not.toContain("123-45-6789");
  });
});
