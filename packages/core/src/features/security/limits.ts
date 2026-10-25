import { bodyTooLarge, fileTargetOf, HttpError, parseSize, setBodyPolicy, type EntityModel } from "../public.ts";
import type { SecurityState, SecurityStep } from "./pipeline.ts";
import type { SecurityRoute } from "./routes.ts";

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
      if (pathAndQueryLength(request.url) > maxUrl) throw state.refuse("limits", new HttpError(414, "URL is too long"));
      if (!headersWithinLimits(request.headers, maxHeaders, options.headerCount)) throw state.refuse("limits", new HttpError(431, "Request headers are too large"));
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
  /** Whether routes carry `@limits` tags, so the step looks up the request's route. */
  byRoute?: boolean;
}

/** The body limit a route's `@limits` tag gives it, in bytes: its own `body`, none with `@limits off`, or undefined without the tag. */
export function routeBodyLimit(route: SecurityRoute | undefined): number | null | undefined {
  const tag = route?.tags.limits;
  if (!tag) return undefined;
  if (!tag.on) return null;
  const body = (tag.options as { body?: string | number }).body;
  return body === undefined ? undefined : parseSize(body);
}

/**
 * The body policy step: refuses a non-multipart body declaring more than the limit (the route's `@limits body`, or the
 * global one) before reading it, and gives every body its policy, which the body readers honor.
 */
export function bodyStep(settings: BodySettings): SecurityStep {
  const read = settings.read !== undefined ? { readTimeout: settings.read } : {};
  const multipart = settings.upload !== undefined ? { readTimeout: settings.upload } : undefined;
  const policyFor = (maxBytes: number | undefined) => ({ ...(maxBytes !== undefined ? { maxBytes } : {}), ...read });
  const global = policyFor(settings.maxBytes);
  // A declared length within the limit is enforced by the runtime, so only a deadline needs a policy then.
  const declared = settings.read !== undefined ? read : undefined;
  return {
    name: "body",
    before(state: SecurityState) {
      const { request } = state.ctx;
      if (request.method === "GET" || request.method === "HEAD") return;
      if (isMultipartRequest(request)) {
        if (multipart) setBodyPolicy(request, multipart);
        return;
      }
      const own = settings.byRoute ? routeBodyLimit(state.route) : undefined;
      const maxBytes = own === undefined ? settings.maxBytes : (own ?? undefined);
      const length = request.headers.get("content-length");
      if (length === null) {
        setBodyPolicy(request, own === undefined ? global : policyFor(maxBytes));
        return;
      }
      if (maxBytes !== undefined && Number(length) > maxBytes) throw state.refuse("limits", bodyTooLarge(maxBytes));
      if (declared) setBodyPolicy(request, declared);
    },
  };
}
