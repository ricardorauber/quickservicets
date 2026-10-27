import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { http, type HttpClientError } from "@quickservicets/core";
import { mockHttp } from "@quickservicets/core/testing";
import { startTestService } from "@quickservicets/cli/testing";
import { QUOTES, startUpstream } from "../scripts/upstream.ts";

const root = join(import.meta.dir, "..");

/** The example's own files, as `startTestService` takes them. */
function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = { "quickservicets.config.ts": readFileSync(join(root, "quickservicets.config.ts"), "utf8") };
  for (const folder of ["endpoints", "features", "jobs"]) {
    for (const entry of readdirSync(join(root, folder), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files[relative(root, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), "utf8");
    }
  }
  return files;
}

const saved = process.env.QUOTES_URL;
afterEach(() => {
  if (saved === undefined) delete process.env.QUOTES_URL;
  else process.env.QUOTES_URL = saved;
});

test("GET /quote calls the upstream with the request id and the user, then answers from the cache; /flaky succeeds on the retry; metadata is blocked", async () => {
  const upstream = startUpstream(0);
  process.env.QUOTES_URL = upstream.url;
  const service = await startTestService({ files: exampleFiles() });
  try {
    const first = await service.fetch("/quote", { headers: { "x-user-id": "u1" } });
    expect(QUOTES).toContain(((await first.json()) as { quote: string }).quote);
    expect(upstream.seen[0]).toEqual({ path: "/quotes/random", requestId: first.headers.get("x-request-id"), userId: "u1" });

    expect((await service.fetch("/quote")).status).toBe(200);
    expect(upstream.seen.filter((request) => request.path === "/quotes/random")).toHaveLength(1);

    expect(await (await service.fetch("/flaky")).json()).toEqual({ ok: true, attempts: 2 });

    const blocked = await http.get("http://169.254.169.254/latest/meta-data").send().catch((error: HttpClientError) => error);
    expect((blocked as HttpClientError).code).toBe("SSRF_BLOCKED");
  } finally {
    await service.stop();
    upstream.stop();
  }
});

test("http.mock() answers the quotes service without starting the upstream", async () => {
  process.env.QUOTES_URL = "http://quotes.test";
  const service = await startTestService({ files: exampleFiles() });
  const mock = mockHttp();
  try {
    mock.service("quotes").on("GET", "/quotes/random").reply(200, { text: "Mocked wisdom." });
    expect(await (await service.fetch("/quote")).json()).toEqual({ quote: "Mocked wisdom." });
    expect(mock.calls).toHaveLength(1);
  } finally {
    mock.restore();
    await service.stop();
  }
});
