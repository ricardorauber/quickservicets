import { http } from "@quickservicets/core";

/** A quote from the upstream service at QUOTES_URL. */
export default async () => {
  const quote = await http.get(`${process.env.QUOTES_URL ?? "http://localhost:4100"}/quotes/random`).send<{ text: string }>();
  return { quote: quote.text };
};
