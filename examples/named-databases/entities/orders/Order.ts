import type { Customer } from "../Customer.ts";

/** An order, in the orders database: its customer lives in the default database. */
export type Order = {
  /** @minLength 1 */
  number: string;
  customer: Customer;
  /** @default false */
  paid: boolean;
};
