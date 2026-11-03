import { events, type Repositories, type ServiceRequest } from "@quickservicets/core";

declare module "@quickservicets/core" {
  interface EventMap {
    "invoice.paid": { invoiceId: string };
  }
}

/** Marks an invoice paid by emitting `invoice.paid`, which subscriptions to it receive as a webhook. */
export default async (_repos: Repositories, req: ServiceRequest) => {
  await events.emit("invoice.paid", { invoiceId: req.params.id! });
  return { invoiceId: req.params.id, paid: true };
};
