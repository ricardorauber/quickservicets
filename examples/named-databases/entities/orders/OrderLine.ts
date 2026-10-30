import type { Order } from "./Order.ts";

/** One line of an order, in the orders database with it: deleting the order deletes its lines. */
export type OrderLine = {
  /** @onDelete cascade */
  order: Order;
  /** @minLength 1 */
  sku: string;
  /** @min 1 @integer */
  quantity: number;
};
