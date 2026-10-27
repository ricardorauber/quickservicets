import { boolean, CORE_VERSION, duration, integer, list, object, size, string, type Options } from "../public.ts";

/** The options of the `http` native. */
export const httpOptions = object({
  timeout: duration().default("10s").describe("The longest an outgoing call may take, reading the response body included; a call sets its own with .timeout()."),
  maxResponseSize: size().default("10MB").describe("The largest response body a call reads; a larger one fails the call with RESPONSE_TOO_LARGE."),
  userAgent: string()
    .default(`quickservicets/${CORE_VERSION}`)
    .describe("The user-agent header of every outgoing call, unless the call sets one."),
  ssrf: boolean()
    .default(true)
    .describe("Blocks calls to internal networks, the machine itself and cloud metadata endpoints, checking every resolved address and every redirect."),
  allow: list(string())
    .default([])
    .describe("Addresses, CIDR blocks (or loopback, private, linklocal) and host names like billing.internal or *.internal that SSRF protection lets through."),
  maxRedirects: integer().min(0).max(20).default(5).describe("How many redirects a call follows before it fails with TOO_MANY_REDIRECTS."),
});

/** The resolved options of the `http` native. */
export type HttpOptions = Options<typeof httpOptions> & { enabled: boolean };
