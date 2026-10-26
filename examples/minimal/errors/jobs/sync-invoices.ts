import { job } from "@quickservicets/core";

/** Syncs invoices every night; the provider is down, so it fails on purpose. */
export default job("@daily", async () => {
  throw new Error("The invoice provider refused the connection");
});
