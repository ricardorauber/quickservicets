import { queue } from "../../public.ts";
import type { IncomingMessage } from "../incoming.ts";
import { runningDeliveries } from "../running.ts";

/** Runs the `handle` of an asynchronous webhook route for one verified delivery; the queue retries a failure. */
export default queue<IncomingMessage>(async (ctx) => {
  await runningDeliveries().incoming(ctx.payload, { repos: ctx.repos, log: ctx.log });
});
