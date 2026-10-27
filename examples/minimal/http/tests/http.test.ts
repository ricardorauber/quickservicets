import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { startTestService } from "@quickservicets/cli/testing";

const root = join(import.meta.dir, "..");

/** The example's own files, as `startTestService` takes them. */
function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = { "quickservicets.config.ts": readFileSync(join(root, "quickservicets.config.ts"), "utf8") };
  for (const folder of ["endpoints"]) {
    for (const entry of readdirSync(join(root, folder), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files[relative(root, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), "utf8");
    }
  }
  return files;
}

/** A tiny upstream answering GET /quotes/random. */
const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ text: "Simple is better than complex." }) });
beforeAll(() => {
  process.env.QUOTES_URL = `http://127.0.0.1:${upstream.port}`;
});
afterAll(() => {
  delete process.env.QUOTES_URL;
  upstream.stop(true);
});

test("GET /quote answers the upstream's quote", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    expect(await (await service.fetch("/quote")).json()).toEqual({ quote: "Simple is better than complex." });
  } finally {
    await service.stop();
  }
});

test("an unreachable upstream answers 502 BAD_GATEWAY", async () => {
  const service = await startTestService({ files: exampleFiles() });
  const saved = process.env.QUOTES_URL;
  process.env.QUOTES_URL = "http://127.0.0.1:1";
  try {
    const response = await service.fetch("/quote");
    expect([response.status, ((await response.json()) as { error: { code: string } }).error.code]).toEqual([502, "BAD_GATEWAY"]);
  } finally {
    process.env.QUOTES_URL = saved;
    await service.stop();
  }
});
