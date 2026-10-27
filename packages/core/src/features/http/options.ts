import { boolean, CORE_VERSION, duration, integer, list, object, record, secret, size, string, url, type Options, type OptionsInput } from "../public.ts";

/** What a service name looks like. */
export const SERVICE_NAME = /^[a-z][a-z0-9-]*$/;

/** The options of one named service. */
export const serviceOptions = object({
  url: url().describe("The service's base URL; call paths are joined to its path, like https://billing.internal/v1."),
  headers: record(string().describe("The value of the header."))
    .optional()
    .describe("Headers sent with every call to the service, under the headers the call sets."),
  auth: object({
    bearer: secret().optional().describe("Sends the token as authorization: Bearer."),
    basic: object({
      username: string().describe("The user name."),
      password: secret().describe("The password."),
    })
      .optional()
      .describe("Sends authorization: Basic with the user name and password."),
    apiKey: object({
      header: string().default("x-api-key").describe("The header that carries the key."),
      value: secret().describe("The key."),
    })
      .optional()
      .describe("Sends the key in a header."),
  })
    .optional()
    .describe("How calls to the service authenticate: one of bearer, basic or apiKey."),
  timeout: duration().optional().describe("The timeout of calls to the service, instead of http.timeout."),
});

/** The resolved options of one named service. */
export type ServiceOptions = Options<typeof serviceOptions>;

/** The options a named service is declared with. */
export type ServiceOptionsInput = OptionsInput<typeof serviceOptions>;

/** The problem of a service's options beyond their schema: more than one authentication method. */
export function serviceProblems(name: string, service: ServiceOptions): string[] {
  const methods = ["bearer", "basic", "apiKey"].filter((method) => (service.auth as Record<string, unknown> | undefined)?.[method] !== undefined);
  return methods.length > 1 ? [`Invalid http.services.${name}.auth: use only one of bearer, basic or apiKey`] : [];
}

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
  services: record(serviceOptions)
    .keys(SERVICE_NAME, "a service name starts with a lowercase letter and uses lowercase letters, digits and -")
    .describe("The services the project calls, by name, each called with http.service(name)."),
});

/** The resolved options of the `http` native. */
export type HttpOptions = Options<typeof httpOptions> & { enabled: boolean };
