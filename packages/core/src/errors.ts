export interface FieldErrorDetail {
  field: string;
  message: string;
}

export interface HttpErrorOptions {
  code?: string;
  details?: unknown;
}

/** The `error.code` clients read for each HTTP status. */
export const CODES_BY_STATUS: Readonly<Record<number, string>> = {
  400: "VALIDATION_ERROR",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  405: "METHOD_NOT_ALLOWED",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  500: "INTERNAL_ERROR",
};

export function codeForStatus(status: number): string {
  return CODES_BY_STATUS[status] ?? `HTTP_${status}`;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, message: string, options: HttpErrorOptions = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = options.code ?? codeForStatus(status);
    this.details = options.details;
  }
}

export interface ErrorResponseOptions {
  production: boolean;
}

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

function jsonResponse(status: number, body: ErrorBody): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function toErrorResponse(error: unknown, options: ErrorResponseOptions): Response {
  if (error instanceof HttpError) {
    const body: ErrorBody = { error: { code: error.code, message: error.message } };
    if (error.details !== undefined) body.error.details = error.details;
    return jsonResponse(error.status, body);
  }

  const body: ErrorBody = { error: { code: codeForStatus(500), message: "Internal server error" } };
  if (!options.production) {
    body.error.details = { stack: error instanceof Error ? error.stack : String(error) };
  }
  return jsonResponse(500, body);
}
