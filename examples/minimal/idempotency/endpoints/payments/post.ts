import type { ServiceRequest, ServiceResponse } from "@quickservice/core";

/** Charges a card; a retried request with the same Idempotency-Key gets the first charge back instead of a second one. */
export default async (_repos: unknown, req: ServiceRequest, res: ServiceResponse) => {
  const { amount } = (await req.json()) as { amount: number };
  // The payment provider takes a moment to answer.
  await Bun.sleep(100);
  res.status(201);
  return { paymentId: crypto.randomUUID(), amount };
};
