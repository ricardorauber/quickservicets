import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { startTestService } from "@quickservicets/cli/testing";

const root = join(import.meta.dir, "..");

/** The example's own files, as `startTestService` takes them. */
function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = { "quickservicets.config.ts": readFileSync(join(root, "quickservicets.config.ts"), "utf8") };
  for (const folder of ["entities", "endpoints"]) {
    for (const entry of readdirSync(join(root, folder), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files[relative(root, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), "utf8");
    }
  }
  return files;
}

const LOCAL = { peer: "127.0.0.1" };
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
type Series = { route: string; tenant: string; requests: number; errors: number; errorRate: number; p95: number };

test("usage per tenant with the error rate, the Prometheus exposition and access refusals", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    const tenant = (id: string) => ({ headers: { "x-tenant-id": id } });
    for (let i = 0; i < 6; i++) await service.fetch("/posts/feed", tenant("acme"));
    for (let i = 0; i < 4; i++) await service.fetch("/posts/feed", tenant("globex"));
    await service.fetch("/internal/ping");
    await settle();

    const body = (await (await service.fetch("/_metrics?last=15m", LOCAL)).json()) as { totals: { requests: number; errors: number; errorRate: number }; series: Series[] };
    expect(body.totals).toMatchObject({ requests: 10, errors: 2, errorRate: 0.2 });
    const acme = body.series.find((series) => series.tenant === "acme")!;
    const globex = body.series.find((series) => series.tenant === "globex")!;
    expect(acme).toMatchObject({ route: "GET /posts/feed", requests: 6, errors: 1 });
    expect(globex).toMatchObject({ route: "GET /posts/feed", requests: 4, errors: 1, errorRate: 0.25 });
    expect(body.series.some((series) => series.route.includes("/internal/ping"))).toBe(false);
    const filtered = (await (await service.fetch("/_metrics?tenant=globex", LOCAL)).json()) as { series: Series[] };
    expect(filtered.series.map((series) => series.tenant)).toEqual(["globex"]);

    const text = await (await service.fetch("/_metrics?format=prometheus", LOCAL)).text();
    expect(text).toContain('quickservicets_http_requests_total{method="GET",route="/posts/feed",status_class="2xx",tenant="acme"} 5');
    expect(text).toContain('quickservicets_http_requests_total{method="GET",route="/posts/feed",status_class="5xx",tenant="globex"} 1');
    expect(text).toContain('quickservicets_http_request_duration_seconds_bucket{method="GET",route="/posts/feed",tenant="acme",le="+Inf"} 6');

    const refused = await service.fetch("/_metrics", { peer: "203.0.113.20" });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toBe("Metrics are not available from this address");
  } finally {
    await service.stop();
  }
});
