export interface FieldErrorDetail {
  field: string;
  message: string;
}

export interface HttpErrorOptions {
  code?: string;
  details?: unknown;
  /** Headers the error response carries, like `retry-after`. */
  headers?: Readonly<Record<string, string>>;
}

/** The `error.code` clients read for each HTTP status. */
export const CODES_BY_STATUS: Readonly<Record<number, string>> = {
  400: "VALIDATION_ERROR",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  405: "METHOD_NOT_ALLOWED",
  408: "REQUEST_TIMEOUT",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  414: "URI_TOO_LONG",
  415: "UNSUPPORTED_MEDIA_TYPE",
  429: "RATE_LIMITED",
  431: "REQUEST_HEADER_FIELDS_TOO_LARGE",
  500: "INTERNAL_ERROR",
  503: "SERVICE_UNAVAILABLE",
};

export function codeForStatus(status: number): string {
  return CODES_BY_STATUS[status] ?? `HTTP_${status}`;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly headers?: Readonly<Record<string, string>>;

  constructor(status: number, message: string, options: HttpErrorOptions = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = options.code ?? codeForStatus(status);
    this.details = options.details;
    if (options.headers) this.headers = options.headers;
  }
}

export interface ErrorResponseOptions {
  production: boolean;
  /** Changes the stack text a development response shows, like masking secret values in it. */
  redact?: (text: string) => string;
}

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

function jsonResponse(status: number, body: ErrorBody, headers?: Readonly<Record<string, string>>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: headers ? { ...headers, "content-type": "application/json" } : { "content-type": "application/json" },
  });
}

export function toErrorResponse(error: unknown, options: ErrorResponseOptions): Response {
  if (error instanceof HttpError) {
    const body: ErrorBody = { error: { code: error.code, message: error.message } };
    if (error.details !== undefined) body.error.details = error.details;
    return jsonResponse(error.status, body, error.headers);
  }

  const body: ErrorBody = { error: { code: codeForStatus(500), message: "Internal server error" } };
  if (!options.production) {
    const stack = error instanceof Error ? error.stack : String(error);
    body.error.details = { stack: stack !== undefined && options.redact ? options.redact(stack) : stack };
  }
  return jsonResponse(500, body);
}
