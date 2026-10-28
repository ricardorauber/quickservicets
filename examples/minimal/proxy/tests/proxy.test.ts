import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestService } from "@quickservicets/cli/testing";
import { startCatalog } from "../scripts/catalog.ts";

const root = join(import.meta.dir, "..");
const catalog = startCatalog(0);
afterAll(() => catalog.stop(true));

test("the gateway forwards /catalog/* to the catalog with the proxy headers", async () => {
  const service = await startTestService({
    files: { "quickservicets.config.ts": readFileSync(join(root, "quickservicets.config.ts"), "utf8") },
    env: { QS_PROXY_ROUTES_CATALOG_TARGET: `http://127.0.0.1:${catalog.port}` },
  });
  try {
    expect(await (await service.fetch("/catalog/products")).json()).toEqual([{ id: "p1", name: "Desk" }]);
    const echoed = (await (await service.fetch("/catalog/items?page=2", { peer: "198.51.100.7" })).json()) as { path: string; forwardedFor: string; host: string };
    expect(echoed).toEqual({ path: "/catalog/items?page=2", forwardedFor: "198.51.100.7", host: `127.0.0.1:${catalog.port}` });
    expect((await service.fetch("/catalog/missing")).status).toBe(404);
  } finally {
    await service.stop();
  }
});
