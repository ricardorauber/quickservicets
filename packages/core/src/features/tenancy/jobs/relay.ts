import { job } from "../../public.ts";
import { relayState } from "../relay.ts";

/**
 * Moves, every day, the queue and outbox rows that database-strategy tenants staged and no relay moved yet (a crash
 * between a commit and its relay), opening their pools as needed.
 */
export default job("@daily", async () => {
  if (!relayState.all) throw new Error("tenancy/relay needs the tenancy native running");
  await relayState.all();
});
