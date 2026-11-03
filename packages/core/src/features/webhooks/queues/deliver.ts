import { queue } from "../../public.ts";
import { runningDeliveries } from "../running.ts";

/**
 * One attempt of a webhook delivery: the payload is the delivery's id. The native schedules retries itself, so the
 * queue never retries a message.
 */
export default queue<string>(async (ctx) => {
  await runningDeliveries().deliver(ctx.payload, { signal: ctx.signal });
}, { retries: 0 });
