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

/** The steps of the `limits` item: URL and header checks, then the body policy of non-multipart requests. */
export function limitsSteps(options: LimitsOptions): SecurityStep[] {
  const maxUrl = parseSize(options.url)!;
  const maxHeaders = parseSize(options.headers)!;
  const maxBody = parseSize(options.body)!;
  const policy = { maxBytes: maxBody };
  return [
    {
      name: "limits",
      before(state: SecurityState) {
        const { request } = state.ctx;
        if (pathAndQueryLength(request.url) > maxUrl) throw new HttpError(414, "URL is too long");
        if (!headersWithinLimits(request.headers, maxHeaders, options.headerCount)) throw new HttpError(431, "Request headers are too large");
      },
    },
    {
      name: "body",
      before(state: SecurityState) {
        const { request } = state.ctx;
        if (request.method === "GET" || request.method === "HEAD" || isMultipartRequest(request)) return;
        const declared = request.headers.get("content-length");
        if (declared !== null && Number(declared) > maxBody) throw bodyTooLarge(maxBody);
        // A declared length is enforced by the runtime; a streamed body is counted while it is read.
        if (declared === null) setBodyPolicy(request, policy);
      },
    },
  ];
}
