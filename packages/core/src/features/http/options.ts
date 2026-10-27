import { CORE_VERSION, duration, object, size, string, type Options } from "../public.ts";

/** The options of the `http` native. */
export const httpOptions = object({
  timeout: duration().default("10s").describe("The longest an outgoing call may take, reading the response body included; a call sets its own with .timeout()."),
  maxResponseSize: size().default("10MB").describe("The largest response body a call reads; a larger one fails the call with RESPONSE_TOO_LARGE."),
  userAgent: string()
    .default(`quickservicets/${CORE_VERSION}`)
    .describe("The user-agent header of every outgoing call, unless the call sets one."),
});

/** The resolved options of the `http` native. */
export type HttpOptions = Options<typeof httpOptions> & { enabled: boolean };
