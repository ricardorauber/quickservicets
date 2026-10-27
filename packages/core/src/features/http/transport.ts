import { formatSize, maskUrl, parseSize } from "../public.ts";
import type { HttpRequest, HttpResponse, HttpSettings } from "./client.ts";
import { HttpClientError } from "./errors.ts";

/** A URL as logs and errors show it: secret query values and user information replaced with `[secret]`. */
export function maskedUrl(url: string, settings: Pick<HttpSettings, "maskKeys">): string {
  return maskUrl(url, { keys: settings.maskKeys });
}

/** A response whose body was read in full. */
export class BufferedResponse implements HttpResponse {
  readonly ok: boolean;

  constructor(
    readonly status: number,
    readonly headers: Headers,
    readonly url: string,
    readonly body: Uint8Array,
    private readonly invalid: (cause: unknown) => Error,
  ) {
    this.ok = status >= 200 && status < 300;
  }

  async json<T = unknown>(): Promise<T> {
    try {
      return JSON.parse(new TextDecoder().decode(this.body)) as T;
    } catch (error) {
      throw this.invalid(error);
    }
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.body);
  }

  async bytes(): Promise<Uint8Array> {
    return this.body.slice();
  }
}

/** The text of a size, like `10MB`, for messages. */
function sizeText(value: string | number): string {
  return typeof value === "string" && !/^\d+$/.test(value.trim()) ? value : formatSize(parseSize(value) ?? 0);
}

/** Reads a body up to `limit` bytes; past it, stops reading and calls `tooLarge`. */
async function readLimited(response: Response, limit: number, tooLarge: () => Error): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The reason of a network failure, as the message shows it. */
function reasonOf(error: unknown): string {
  const failure = error as { code?: unknown; message?: unknown } | undefined;
  if (typeof failure?.code === "string" && failure.code !== "") return failure.code;
  return typeof failure?.message === "string" ? failure.message : String(error);
}

/**
 * Sends one attempt of a request over the network: the timeout covers reading the body, the body is read up to the
 * size limit, and failures become `HttpClientError`s.
 */
export async function transport(request: HttpRequest, settings: HttpSettings): Promise<HttpResponse> {
  const { method } = request;
  const url = maskedUrl(request.url, settings);
  const service = request.service !== undefined ? { service: request.service } : {};
  const fail = (code: string, message: string, cause?: unknown) => new HttpClientError({ code, message, method, url, ...(cause !== undefined ? { cause } : {}), ...service });
  if (request.signal?.aborted) throw fail("ABORTED", `${method} ${url} was aborted`, request.signal.reason);
  const limit = parseSize(settings.options.maxResponseSize) ?? Number.POSITIVE_INFINITY;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeout);
  const signal = request.signal ? AbortSignal.any([controller.signal, request.signal]) : controller.signal;
  const failure = (error: unknown) => {
    if (error instanceof HttpClientError) return error;
    if (timedOut) return fail("TIMEOUT", `${method} ${url} timed out after ${formatTimeoutText(request.timeout)}`, error);
    if (request.signal?.aborted) return fail("ABORTED", `${method} ${url} was aborted`, request.signal.reason);
    return fail("NETWORK", `${method} ${url} failed: ${reasonOf(error)}`, error);
  };
  try {
    const response = await fetch(request.url, { method, headers: request.headers, body: (request.body ?? null) as RequestInit["body"], signal, redirect: "follow" });
    const tooLarge = () => fail("RESPONSE_TOO_LARGE", `Response from ${url} is larger than ${sizeText(settings.options.maxResponseSize)}`);
    const body = await readLimited(response, limit, tooLarge);
    const answered = response.url || request.url;
    const invalid = (cause: unknown) => new HttpClientError({ code: "INVALID_RESPONSE", message: `${method} ${maskedUrl(answered, settings)} answered invalid JSON`, method, url: maskedUrl(answered, settings), cause, ...service });
    return new BufferedResponse(response.status, response.headers, answered, body, invalid);
  } catch (error) {
    throw failure(error);
  } finally {
    clearTimeout(timer);
  }
}

/** A timeout as messages show it: `500ms`, `10s`. */
function formatTimeoutText(ms: number): string {
  return ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}
