import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { testAuth } from "@quickservicets/core/testing";
import { startTestService } from "@quickservicets/cli/testing";
import { startCatalog } from "../scripts/catalog.ts";
import { startOrders } from "../scripts/orders.ts";

const root = join(import.meta.dir, "..");
const SECRET = "example-gateway-secret";
process.env.GATEWAY_SECRET = SECRET;
const catalog = startCatalog(0);
const orders = startOrders(SECRET, 0);
afterAll(() => {
  catalog.stop(true);
  orders.stop(true);
});

const config = readFileSync(join(root, "quickservicets.config.ts"), "utf8");
const env = {
  GATEWAY_SECRET: SECRET,
  QS_PROXY_ROUTES_CATALOG_TARGET: `http://127.0.0.1:${catalog.port}`,
  QS_PROXY_ROUTES_ORDERS_TARGET: `http://127.0.0.1:${orders.port}`,
  QS_PROXY_ROUTES_CATALOG_RATE_LIMIT_LIMIT: "3/min",
  QS_PROXY_ROUTES_ORDERS_TIMEOUT: "200ms",
};

test("the gateway forwards, strips, signs identities, refuses anonymous orders, limits the catalog and times out", async () => {
  const service = await startTestService({ files: { "quickservicets.config.ts": config }, env, auth: testAuth() });
  try {
    expect(await (await service.fetch("/catalog/products")).json()).toEqual([{ id: "p1", name: "Desk" }]);
    const echoed = (await (await service.fetch("/catalog/items?page=2", { peer: "198.51.100.7" })).json()) as { path: string; forwardedFor: string };
    expect(echoed).toEqual({ path: "/items?page=2", forwardedFor: "198.51.100.7" });

    const user = { headers: { "x-test-user": "u1;tenant=acme" } };
    expect(await (await service.fetch("/orders/list", user)).json()).toEqual({ orders: [{ id: "o1", total: 42 }], user: "u1", tenant: "acme" });
    expect((await service.fetch("/orders/list")).status).toBe(401);
    const forged = await fetch(`http://127.0.0.1:${orders.port}/orders/list`, { headers: { "x-user-id": "admin", "x-quickservicets-identity": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}` } });
    expect(forged.status).toBe(401);

    const peer = { peer: "203.0.113.50" };
    for (let i = 0; i < 3; i++) expect((await service.fetch("/catalog/products", peer)).status).toBe(200);
    expect((await service.fetch("/catalog/products", peer)).status).toBe(429);

    const slow = await service.fetch("/orders/slow", user);
    expect(slow.status).toBe(504);
  } finally {
    await service.stop();
  }
});

test("a target function only reaches the origins on allowedTargets", async () => {
  const byTenant = config.replace(
    'target: "http://127.0.0.1:4102", auth: "required"',
    `target: ({ tenant }) => (tenant?.id === "acme" ? "http://127.0.0.1:${orders.port}" : "http://127.0.0.1:1"), allowedTargets: ["http://127.0.0.1:${orders.port}"], auth: "required"`,
  );
  const service = await startTestService({ files: { "quickservicets.config.ts": byTenant }, env: { GATEWAY_SECRET: SECRET }, auth: testAuth() });
  try {
    expect((await service.fetch("/orders/list", { headers: { "x-test-user": "u1;tenant=acme" } })).status).toBe(200);
    expect((await service.fetch("/orders/list", { headers: { "x-test-user": "u2;tenant=globex" } })).status).toBe(502);
  } finally {
    await service.stop();
  }
});
