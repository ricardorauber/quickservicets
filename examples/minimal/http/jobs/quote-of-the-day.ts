import { job } from "@quickservicets/core";

/** Fetches a quote every morning; ctx.http sends the run's id as x-request-id. */
export default job("@daily", async (ctx) => {
  const quote = await ctx.http.service("quotes").get("/quotes/random").send<{ text: string }>();
  ctx.log.info("quote of the day", { text: quote.text });
  return quote;
});
