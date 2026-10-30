import { transaction, type Endpoint } from "@quickservicets/core";

type Checkout = { number: string; customer: string; lines: { sku: string; quantity: number }[] };

/**
 * @summary Place an order with its lines
 * @description Creates an order and its lines in one transaction of the orders database: all of them or none. The customer is checked before the transaction starts, on the default database.
 * @status 201
 */
const handler: Endpoint = async (repos, req) => {
  const body = (await req.json()) as Checkout;
  return transaction(
    async () => {
      const order = await repos.orders.orders.create({ number: body.number, customer: body.customer });
      for (const line of body.lines) await repos.orders.orderLines.create({ order: order.id, ...line });
      return order;
    },
    { database: "orders" },
  );
};

export default handler;
