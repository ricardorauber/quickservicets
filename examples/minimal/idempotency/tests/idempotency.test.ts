import { afterEach, expect, setSystemTime, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { startTestService } from "@quickservice/cli/testing";

const root = join(import.meta.dir, "..");

/** The example's own files, as `startTestService` takes them. */
function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = { "quickservice.config.ts": readFileSync(join(root, "quickservice.config.ts"), "utf8") };
  for (const dir of ["entities", "endpoints"]) {
    for (const entry of readdirSync(join(root, dir), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files[relative(root, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), "utf8");
    }
  }
  return files;
}

const post = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const error = async (response: Response) => [response.status, ((await response.json()) as { error: { code: string; message: string } }).error] as const;

afterEach(() => setSystemTime());

test("a repeated order is replayed, an order without a key is refused, and a key reused with another body is 422", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    const first = await service.fetch("/orders", post({ item: "book", quantity: 1 }, { "idempotency-key": "order-1" }));
    const again = await service.fetch("/orders", post({ item: "book", quantity: 1 }, { "idempotency-key": "order-1" }));
    expect([first.status, again.status, again.headers.get("idempotent-replayed")]).toEqual([201, 201, "true"]);
    expect(await again.json()).toEqual(await first.json());
    expect(await error(await service.fetch("/orders", post({ item: "book", quantity: 1 })))).toEqual([400, { code: "VALIDATION_ERROR", message: "Idempotency-Key header is required" }]);
    expect(await error(await service.fetch("/orders", post({ item: "book", quantity: 2 }, { "idempotency-key": "order-1" })))).toEqual([
      422,
      { code: "IDEMPOTENCY_KEY_REUSED", message: "Idempotency-Key was used with a different request" },
    ]);
  } finally {
    await service.stop();
  }
});

test("a concurrent duplicate payment is refused with 409 while the first one runs", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    const [a, b] = await Promise.all([service.fetch("/payments", post({ amount: 10 }, { "idempotency-key": "pay-1" })), service.fetch("/payments", post({ amount: 10 }, { "idempotency-key": "pay-1" }))]);
    const conflict = a.status === 409 ? a : b;
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(conflict.headers.get("retry-after")).toBe("1");
    const settled = await service.fetch("/payments", post({ amount: 10 }, { "idempotency-key": "pay-1" }));
    expect([settled.status, settled.headers.get("idempotent-replayed")]).toEqual([201, "true"]);
  } finally {
    await service.stop();
  }
});

test("batch clients' keys last a week, the others' a day", async () => {
  const now = Date.now();
  setSystemTime(new Date(now));
  const service = await startTestService({ files: exampleFiles() });
  try {
    await service.fetch("/payments", post({ amount: 5 }, { "idempotency-key": "batch-1", "x-client": "batch" }));
    await service.fetch("/payments", post({ amount: 5 }, { "idempotency-key": "web-1" }));
    setSystemTime(new Date(now + 2 * 86_400_000));
    expect((await service.fetch("/payments", post({ amount: 5 }, { "idempotency-key": "batch-1", "x-client": "batch" }))).headers.get("idempotent-replayed")).toBe("true");
    expect((await service.fetch("/payments", post({ amount: 5 }, { "idempotency-key": "web-1" }))).headers.get("idempotent-replayed")).toBeNull();
  } finally {
    await service.stop();
  }
});
