import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { testAuth } from "@quickservicets/core/testing";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";
import { eject } from "./eject.ts";
import { startCatalog } from "../../../../examples/minimal/proxy/scripts/catalog.ts";
import { startOrders } from "../../../../examples/minimal/proxy/scripts/orders.ts";

const example = join(import.meta.dir, "../../../../examples/minimal/proxy");
const SECRET = "eject-gateway-secret";
process.env.GATEWAY_SECRET = SECRET;
const catalog = startCatalog(0);
const orders = startOrders(SECRET, 0);
afterAll(() => {
  catalog.stop(true);
  orders.stop(true);
});

test("quickservicets eject proxy turns the native into features/proxy/ and the gateway keeps forwarding, stripping and signing", async () => {
  const config = readFileSync(join(example, "quickservicets.config.ts"), "utf8");
  const root = createLinkedProject({ "quickservicets.config.ts": config });
  const lines = await eject(root, "proxy");
  expect(lines).toContain("features/proxy/ now replaces the proxy native.");
  expect(existsSync(join(root, "features/proxy/index.ts"))).toBe(true);
  const files: Record<string, string> = { "quickservicets.config.ts": config };
  for (const file of ["index.ts", "forward.ts", "identity.ts", "sockets.ts"]) files[`features/proxy/${file}`] = readFileSync(join(root, "features/proxy", file), "utf8");
  const env = { GATEWAY_SECRET: SECRET, QS_PROXY_ROUTES_CATALOG_TARGET: `http://127.0.0.1:${catalog.port}`, QS_PROXY_ROUTES_ORDERS_TARGET: `http://127.0.0.1:${orders.port}` };
  const service = await startTestService({ files, env, auth: testAuth() });
  try {
    expect(await (await service.fetch("/catalog/products")).json()).toEqual([{ id: "p1", name: "Desk" }]);
    expect(await (await service.fetch("/orders/list", { headers: { "x-test-user": "u1;tenant=acme" } })).json()).toMatchObject({ user: "u1", tenant: "acme" });
    expect((await service.fetch("/orders/list")).status).toBe(401);
  } finally {
    await service.stop();
  }
});
