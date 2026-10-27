import type { Repositories, ServiceRequest } from "@quickservicets/core";

/** A random quote from the quotes service, with the caller's request id and user propagated. */
export default async (_repos: Repositories, req: ServiceRequest) => {
  const quote = await req.http.service("quotes").get("/quotes/random").send<{ text: string }>();
  return { quote: quote.text };
};
