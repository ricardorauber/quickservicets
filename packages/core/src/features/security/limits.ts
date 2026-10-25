import { bodyTooLarge, fileTargetOf, HttpError, parseSize, setBodyPolicy, type EntityModel } from "../public.ts";
import type { SecurityState, SecurityStep } from "./pipeline.ts";

/** The `limits` item's options. */
export interface LimitsOptions {
  enabled: boolean;
  body: string | number;
  headers: string | number;
  headerCount: number;
  url: string | number;
}

/** The form overhead allowed above the largest upload, for boundaries, part headers and form fields. */
export const FORM_OVERHEAD = 64 * 1024;

/** The length of a request URL's path and query, read from the URL text without parsing it again. */
export function pathAndQueryLength(url: string): number {
  const start = url.indexOf("/", url.indexOf("//") + 2);
  return start < 0 ? 0 : url.length - start;
}

/**
 * Whether a request's headers pass the limits: the total length of names and values at most `maxBytes`, and at most
 * `maxCount` headers. One pass over the headers the request holds, without copying them.
 */
export function headersWithinLimits(headers: Headers, maxBytes: number, maxCount: number): boolean {
  let count = 0;
  let bytes = 0;
  headers.forEach((value, name) => {
    count++;
    bytes += name.length + value.length;
  });
  return count <= maxCount && bytes <= maxBytes;
}

/** Whether a request carries a multipart body, which file settings limit instead of `limits.body`. */
export const isMultipartRequest = (request: Request) => request.headers.get("content-type")?.toLowerCase().startsWith("multipart/") === true;

/**
 * The largest multipart body the model allows: a file entity's largest file, or the sum of the largest files of an
 * entity's file fields (an array field's `@maxTotalSize` when set); 0 without uploads.
 */
export function largestUpload(models: readonly EntityModel[], defaultMaxSize: number): number {
  const sizeOf = (target: EntityModel, limit?: number) => Math.min(target.fileLimits?.maxSize ?? defaultMaxSize, limit ?? Number.POSITIVE_INFINITY);
  let largest = 0;
  for (const model of models) {
    if (model.system && !model.file) continue;
    let total = model.file ? sizeOf(model) : 0;
    for (const field of model.fields) {
      const target = fileTargetOf(field, models as EntityModel[]);
      if (!target) continue;
      const limits = field.fileLimits as { maxSize?: number; maxTotalSize?: number } | undefined;
      total += field.type === "ref" ? sizeOf(target, limits?.maxSize) : (limits?.maxTotalSize ?? sizeOf(target, limits?.maxSize));
    }
    largest = Math.max(largest, total);
  }
  return largest;
}

/** The step of the `limits` item that checks the URL and the headers. */
export function limitsStep(options: LimitsOptions): SecurityStep {
  const maxUrl = parseSize(options.url)!;
  const maxHeaders = parseSize(options.headers)!;
  return {
    name: "limits",
    before(state: SecurityState) {
      const { request } = state.ctx;
      if (pathAndQueryLength(request.url) > maxUrl) throw new HttpError(414, "URL is too long");
      if (!headersWithinLimits(request.headers, maxHeaders, options.headerCount)) throw new HttpError(431, "Request headers are too large");
    },
  };
}

/** What the body policy step applies: the body limit of the `limits` item and the read deadlines of `timeouts`. */
export interface BodySettings {
  /** The largest non-multipart body, in bytes. */
  maxBytes?: number;
  /** Milliseconds a non-multipart body has to arrive in. */
  read?: number;
  /** Milliseconds a multipart body has to arrive in. */
  upload?: number;
}

/**
 * The body policy step: refuses a non-multipart body declaring more than the limit before reading it, and gives every
 * body its policy, which the body readers honor.
 */
export function bodyStep(settings: BodySettings): SecurityStep {
  const { maxBytes } = settings;
  const json = { ...(maxBytes !== undefined ? { maxBytes } : {}), ...(settings.read !== undefined ? { readTimeout: settings.read } : {}) };
  const multipart = settings.upload !== undefined ? { readTimeout: settings.upload } : undefined;
  // A declared length within the limit is enforced by the runtime, so only a deadline needs a policy then.
  const declared = settings.read !== undefined ? { readTimeout: settings.read } : undefined;
  return {
    name: "body",
    before(state: SecurityState) {
      const { request } = state.ctx;
      if (request.method === "GET" || request.method === "HEAD") return;
      if (isMultipartRequest(request)) {
        if (multipart) setBodyPolicy(request, multipart);
        return;
      }
      const length = request.headers.get("content-length");
      if (length === null) {
        setBodyPolicy(request, json);
        return;
      }
      if (maxBytes !== undefined && Number(length) > maxBytes) throw bodyTooLarge(maxBytes);
      if (declared) setBodyPolicy(request, declared);
    },
  };
}
