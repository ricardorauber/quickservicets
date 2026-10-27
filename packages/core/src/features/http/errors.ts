/** Why an outgoing call failed. */
export type HttpClientErrorCode = "HTTP_STATUS" | "TIMEOUT" | "ABORTED" | "RESPONSE_TOO_LARGE" | "NETWORK" | "INVALID_RESPONSE" | (string & {});

/** What an `HttpClientError` is built from. */
export interface HttpClientErrorInit {
  code: HttpClientErrorCode;
  message: string;
  /** The upstream status, or 0 without a response. */
  status?: number;
  method: string;
  /** The called URL, with secret query values masked. */
  url: string;
  /** The response body, parsed like `send()` does, at most 64 KB. */
  body?: unknown;
  cause?: unknown;
  /** The named service the call went through. */
  service?: string;
  /** More about the failure, like the patterns of a mock. */
  details?: unknown;
  /** Response headers, when there was a response. */
  headers?: Headers;
}

const BRAND = Symbol.for("quickservicets.http.error");

/**
 * The error of an outgoing call that failed: a status outside 2xx (`HTTP_STATUS`), a timeout, an abort, a body too
 * large, a network failure or an invalid response. An endpoint that lets one escape answers 502 or 504.
 */
export class HttpClientError extends Error {
  readonly code: HttpClientErrorCode;
  readonly status: number;
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
  readonly service?: string;
  readonly details?: unknown;
  /** The response headers, when there was a response. */
  readonly headers?: Headers;

  constructor(init: HttpClientErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "HttpClientError";
    this.code = init.code;
    this.status = init.status ?? 0;
    this.method = init.method;
    this.url = init.url;
    this.body = init.body;
    if (init.service !== undefined) this.service = init.service;
    if (init.details !== undefined) this.details = init.details;
    if (init.headers !== undefined) Object.defineProperty(this, "headers", { value: init.headers, enumerable: false });
    Object.defineProperty(this, BRAND, { value: true });
  }

  /** Whether a value is an `HttpClientError`, from this copy of the core or another (an ejected feature's). */
  static [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[BRAND] === true;
  }
}
