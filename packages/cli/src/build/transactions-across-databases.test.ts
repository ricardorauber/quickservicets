import { expect, test } from "bun:test";
import { events } from "@quickservicets/core";
import { startTestService } from "../testing/service.ts";

const CONFIG = `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ databases: { orders: memoryAdapter() }, queues: { pollInterval: "1s" }, events: {} });
`;
const FILES = {
  "quickservicets.config.ts": CONFIG,
  "entities/Receipt.ts": "export type Receipt = { number: string; database?: string };\n",
  "entities/orders/Order.ts": "export type Order = { number: string };\n",
  "queues/notify.ts": `import { queue } from "@quickservicets/core";
export default queue<{ number: string }>(async ({ payload, repos }) => {
  await (repos as unknown as { receipts: { create(body: unknown): Promise<unknown> } }).receipts.create({ number: payload.number });
});
`,
  "events/order-seen.ts": `import { listen } from "@quickservicets/core";
export default listen("order.created", async (event, { repos }) => {
  await (repos as unknown as { receipts: { create(body: unknown): Promise<unknown> } }).receipts.create({ number: "event", database: event.actor?.database });
});
`,
  "endpoints/place/post.ts": `import { queues, transaction, type ServiceRequest } from "@quickservicets/core";
export default async (repos: { orders: { orders: { create(body: unknown): Promise<unknown> } } }, req: ServiceRequest) => {
  const { number, fail } = (await req.json()) as { number: string; fail?: boolean };
  try {
    await transaction(async () => {
      await repos.orders.orders.create({ number });
      await queues.add("notify", { number });
      if (fail) throw new Error("rolled back");
    });
  } catch {
    return { placed: false };
  }
  return { placed: true };
};
`,
};
type Receipts = { receipts: { query(): { toArray(): Promise<{ number: string; database?: string }[]> } } };
const settle = async (check: () => Promise<boolean>) => {
  for (let attempt = 0; attempt < 400 && !(await check()); attempt++) await Bun.sleep(10);
};

test("a message added in an orders transaction reaches its consumer once after the commit, and never after a rollback", async () => {
  const service = await startTestService({ files: FILES });
  try {
    const receipts = () => (service.repos as unknown as Receipts).receipts.query().toArray();
    const post = (body: unknown) => service.fetch("/place", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(await (await post({ number: "A-1", fail: true })).json()).toEqual({ placed: false });
    expect(await (await post({ number: "A-2" })).json()).toEqual({ placed: true });
    await settle(async () => (await receipts()).some((receipt) => receipt.number === "A-2"));
    await Bun.sleep(50);
    await events.idle();
    const all = await receipts();
    expect(all.filter((receipt) => receipt.number !== "event").map((receipt) => receipt.number)).toEqual(["A-2"]);
    // The write event of the order created in the orders transaction carries its database.
    expect(all.filter((receipt) => receipt.number === "event").map((receipt) => receipt.database)).toEqual(["orders"]);
  } finally {
    await service.stop();
  }
});
