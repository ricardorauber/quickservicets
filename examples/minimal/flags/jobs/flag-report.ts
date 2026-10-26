import { job } from "@quickservice/core";

/** Reads flags outside a request: for a given user, and anonymously. */
export default job("@daily", (ctx) => ({
  checkoutForU1: ctx.flags.on("checkout-v2", { user: { id: "u1" } }),
  darkMode: ctx.flags.on("dark-mode"),
}));
