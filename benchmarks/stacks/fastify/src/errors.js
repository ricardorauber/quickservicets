const CODES = {
  400: "VALIDATION_ERROR",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  500: "INTERNAL_ERROR",
};

/** An error answered with `{"error":{"code","message","details"?}}`. */
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function errorBody(status, message, details) {
  const error = { code: CODES[status] ?? (status >= 500 ? "INTERNAL_ERROR" : "VALIDATION_ERROR"), message };
  if (details !== undefined) error.details = details;
  return { error };
}

export const invalidBody = (details) => new HttpError(400, "Invalid body", details);
