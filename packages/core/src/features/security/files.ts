import { contentDisposition, mimeMatches, type FileHeaders } from "../public.ts";

/** The policy of every served file: no script runs and nothing loads, so a file opened inline stays inert. */
export const FILE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/** The types a browser could run as a page, script or style of the service's origin, served as attachments by default. */
export const DEFAULT_ATTACHMENT_TYPES = ["text/html", "application/xhtml+xml", "image/svg+xml", "text/xml", "application/xml", "application/javascript", "text/javascript", "text/css"];

/**
 * The headers of the `files` item for each served file: `nosniff`, the sandboxing policy, and an `attachment`
 * disposition for the types of `attachmentTypes`.
 */
export function fileHeaders(attachmentTypes: readonly string[]): FileHeaders {
  const inline = { "x-content-type-options": "nosniff", "content-security-policy": FILE_CSP };
  return ({ mimeType, filename }) => (mimeMatches(mimeType, attachmentTypes) ? { ...inline, "content-disposition": contentDisposition(filename, "attachment") } : inline);
}
