const CODES = {
  400: "VALIDATION_ERROR",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  500: "INTERNAL_ERROR",
};

/** An error answered as `{"error":{"code","message","details"?}}`; the code follows from the status. */
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const notFound = (entity) => new HttpError(404, `${entity} not found`);
export const invalidBody = (details) => new HttpError(400, "Invalid body", details);
export const invalidQuery = (details) => new HttpError(400, "Invalid query", details);

export function sendError(res, status, message, details) {
  const error = { code: CODES[status] ?? (status >= 500 ? "INTERNAL_ERROR" : "VALIDATION_ERROR"), message };
  if (details !== undefined) error.details = details;
  res.status(status).json({ error });
}

/** Express error middleware: HttpErrors, body-parser failures, and everything else as a 500. */
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err instanceof HttpError) return sendError(res, err.status, err.message, err.details);
  if (err.type === "entity.parse.failed" || err.type === "entity.verify.failed") return sendError(res, 400, "Invalid JSON body");
  if (err.type === "entity.too.large") return sendError(res, 413, "Payload too large");
  if (typeof err.status === "number" && err.status >= 400 && err.status < 500 && err.expose) {
    return sendError(res, err.status, err.message);
  }
  console.error(err);
  sendError(res, 500, "Internal server error");
}
