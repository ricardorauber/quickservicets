import type { HttpModifier, HttpRequest, HttpResponse } from "./client.ts";
import { HttpClientError } from "./errors.ts";
import { BufferedResponse } from "./transport.ts";

/** What a modifier function receives: the request to change, and `next` to run the rest of the chain. */
export type ModifierFunction = (request: HttpRequest, next: (request?: HttpRequest) => Promise<HttpResponse>) => Promise<HttpResponse | Response> | HttpResponse | Response;

const MODIFIER = Symbol.for("quickservicets.http.modifier");

/**
 * A reusable step around outgoing calls: `fn(request, next)` may change the request, call `next` (any number of
 * times), and resolve its response or a replacement; a thrown error other than an `HttpClientError` fails the call
 * with `MODIFIER_FAILED`.
 */
export function defineModifier(fn: ModifierFunction, name: string = fn.name || "modifier"): HttpModifier {
  if (typeof fn !== "function") throw new TypeError("defineModifier() takes a function (request, next) => response");
  const modifier: HttpModifier = {
    name,
    async run(request, next) {
      const result = await fn(request, next);
      return result instanceof Response ? bufferResponse(result, request.url) : result;
    },
  };
  Object.defineProperty(modifier, MODIFIER, { value: true });
  return Object.freeze(modifier);
}

/** Whether a value is a modifier: from `defineModifier`, or any object with a name and a run method. */
export function isModifier(value: unknown): value is HttpModifier {
  return typeof value === "object" && value !== null && typeof (value as HttpModifier).run === "function";
}

/** A standard `Response` a modifier returned, read into the client's response. */
async function bufferResponse(response: Response, url: string): Promise<HttpResponse> {
  const body = new Uint8Array(await response.arrayBuffer());
  return new BufferedResponse(response.status, response.headers, response.url || url, body, (cause) => cause as Error);
}

/** A request each attempt can change without touching the caller's: its own headers. */
export function copyRequest(request: HttpRequest, changes: Partial<HttpRequest> = {}): HttpRequest {
  return { ...request, headers: new Headers(request.headers), ...changes };
}

/**
 * Runs `chain` from the outermost modifier in, then `last`; a modifier that throws something other than an
 * `HttpClientError` fails the call with `MODIFIER_FAILED`, naming it, with the error as `cause`.
 */
export function runChain(chain: readonly HttpModifier[], request: HttpRequest, last: (request: HttpRequest) => Promise<HttpResponse>, url: () => string): Promise<HttpResponse> {
  const step = async (index: number, current: HttpRequest): Promise<HttpResponse> => {
    if (index === chain.length) return last(current);
    const modifier = chain[index]!;
    try {
      return await modifier.run(current, (next) => step(index + 1, next ?? current));
    } catch (error) {
      if (error instanceof HttpClientError) throw error;
      throw new HttpClientError({
        code: "MODIFIER_FAILED",
        message: `Modifier ${modifier.name} failed: ${(error as Error)?.message ?? String(error)}`,
        method: current.method,
        url: url(),
        cause: error,
        ...(current.service !== undefined ? { service: current.service } : {}),
      });
    }
  };
  return step(0, request);
}
