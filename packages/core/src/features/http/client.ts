import { DEFAULT_MASKED_KEYS, jsonLogger, lastResolvedFeatures, parseDuration, resolveOptions, type Logger } from "../public.ts";
import { HttpClientError } from "./errors.ts";
import { httpOptions, type HttpOptions } from "./options.ts";
import { sharedState } from "./state.ts";
import { maskedUrl, transport } from "./transport.ts";

/** A raw request body. */
export type HttpBody = string | Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array> | URLSearchParams | FormData;

/** A query value: arrays repeat the name, `undefined` and `null` are left out. */
export type HttpQueryValue = string | number | boolean | null | undefined | readonly (string | number | boolean)[];

/** The response of a call, with its body already read. */
export interface HttpResponse {
  readonly status: number;
  /** Whether the status is 2xx. */
  readonly ok: boolean;
  readonly headers: Headers;
  /** The URL that answered, after redirects. */
  readonly url: string;
  /** The body parsed as JSON; rejects with `INVALID_RESPONSE` when it is not JSON. */
  json<T = unknown>(): Promise<T>;
  text(): Promise<string>;
  bytes(): Promise<Uint8Array>;
}

/** The request a modifier receives and may change before calling `next`. */
export interface HttpRequest {
  method: string;
  url: string;
  headers: Headers;
  body: HttpBody | undefined;
  /** The timeout of each attempt, in milliseconds. */
  timeout: number;
  signal: AbortSignal | undefined;
  /** 1 for the first attempt, incremented by retries. */
  attempt: number;
  /** The named service the call goes through. */
  service?: string;
}

/** A step around a call; `next` runs the rest of the chain and resolves its response. */
export interface HttpModifier {
  /** The modifier's name, used in errors. */
  readonly name: string;
  run(request: HttpRequest, next: (request?: HttpRequest) => Promise<HttpResponse>): Promise<HttpResponse>;
}

/** What one call is, before it runs. */
export interface CallSpec {
  method: string;
  url: URL;
  headers: readonly (readonly [string, string])[];
  query: readonly (readonly [string, string])[];
  body?: { kind: "json"; value: unknown } | { kind: "form"; value: Record<string, unknown> | FormData } | { kind: "raw"; value: HttpBody };
  timeout?: number | string;
  signal?: AbortSignal;
  modifiers: readonly HttpModifier[];
}

/** Who a client calls for: the global client calls for nobody. */
export interface ClientBinding {
  /** Sent as `x-request-id` unless the call sets it. */
  requestId?: string;
}

/** The runtime settings of the running native, installed by its setup. */
export interface RunningHttp {
  options: HttpOptions;
  logger: Logger;
  production: boolean;
  /** The query parameter names whose values are masked in logged and reported URLs. */
  maskKeys: readonly string[];
}

/** The settings every call reads. */
export type HttpSettings = RunningHttp;

/** The running native of this process, or undefined until a service with it starts. */
export const running = sharedState("running", () => ({ current: undefined as RunningHttp | undefined }));

/** The error of every call while the native is turned off. */
export const DISABLED = "http is disabled (http: false in quickservicets.config.ts)";

const defaults = sharedState("defaults", () => ({ options: undefined as HttpOptions | undefined }));

/**
 * The settings of the next call: the running native's, else the options of the last resolved configuration, else the
 * option defaults; throws while the last resolved configuration turned the native off.
 */
export function currentSettings(): HttpSettings {
  const resolution = lastResolvedFeatures();
  const feature = resolution?.features.find((candidate) => candidate.key === "http");
  if (resolution && !feature) throw new Error(DISABLED);
  const current = running.current;
  if (current && (!feature || current.options === feature.options)) return current;
  const options = (feature?.options as HttpOptions | undefined) ?? (defaults.options ??= resolveOptions(httpOptions, {}, "http") as HttpOptions);
  return { options, logger: jsonLogger, production: false, maskKeys: DEFAULT_MASKED_KEYS };
}

/** Milliseconds of a duration or a number of milliseconds; throws for anything else. */
export function timeoutMs(value: number | string): number {
  const ms = typeof value === "number" ? value : parseDuration(value);
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) throw new TypeError(`Invalid timeout ${JSON.stringify(value)}: expected milliseconds or a duration like 500ms or 10s`);
  return ms;
}

/** The request a call spec describes, with its headers, query and body applied. */
export function describeCall(spec: CallSpec, settings: HttpSettings, binding: ClientBinding): HttpRequest {
  const url = new URL(spec.url);
  for (const [name, value] of spec.query) url.searchParams.append(name, value);
  const headers = new Headers({ "user-agent": settings.options.userAgent });
  if (binding.requestId !== undefined) headers.set("x-request-id", binding.requestId);
  let body: HttpBody | undefined;
  if (spec.body?.kind === "json") {
    headers.set("content-type", "application/json");
    body = JSON.stringify(spec.body.value);
  } else if (spec.body?.kind === "form") {
    const value = spec.body.value;
    if (value instanceof FormData) body = value;
    else {
      const form = new URLSearchParams();
      for (const [name, item] of Object.entries(value)) appendQuery(form, name, item as HttpQueryValue);
      headers.set("content-type", "application/x-www-form-urlencoded");
      body = form;
    }
  } else if (spec.body?.kind === "raw") body = spec.body.value;
  for (const [name, value] of spec.headers) headers.set(name, value);
  return {
    method: spec.method,
    url: url.href,
    headers,
    body,
    timeout: timeoutMs(spec.timeout ?? settings.options.timeout),
    signal: spec.signal,
    attempt: 1,
  };
}

function appendQuery(target: { append(name: string, value: string): void }, name: string, value: HttpQueryValue): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) for (const item of value) target.append(name, String(item));
  else target.append(name, String(value));
}

/** Runs a call: the modifiers, then the transport. */
export async function execute(spec: CallSpec, binding: ClientBinding): Promise<HttpResponse> {
  const settings = currentSettings();
  const request = describeCall(spec, settings, binding);
  return transport(request, settings);
}

/** The largest body an `HttpClientError` keeps. */
const ERROR_BODY_LIMIT = 64 * 1024;

const isJson = (contentType: string | null) => {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  return type === "application/json" || type.endsWith("+json");
};

/** A body as `send()` resolves it: undefined when empty, JSON for JSON content types, the text otherwise. */
export function parseBody(bytes: Uint8Array, contentType: string | null, invalid: (cause: unknown) => Error): unknown {
  if (bytes.byteLength === 0) return undefined;
  const text = new TextDecoder().decode(bytes);
  if (!isJson(contentType)) return text;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw invalid(error);
  }
}

/** The body an error keeps: parsed like `send()` within 64 KB, the first 64 KB as text otherwise. */
function errorBody(bytes: Uint8Array, contentType: string | null): unknown {
  if (bytes.byteLength > ERROR_BODY_LIMIT) return new TextDecoder().decode(bytes.subarray(0, ERROR_BODY_LIMIT));
  try {
    return parseBody(bytes, contentType, (cause) => cause as Error);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

/** The `HTTP_STATUS` error of a response outside 2xx. */
export async function statusError(response: HttpResponse, method: string, service: string | undefined): Promise<HttpClientError> {
  const settings = currentSettings();
  const url = maskedUrl(response.url, settings);
  return new HttpClientError({
    code: "HTTP_STATUS",
    message: `${method} ${url} responded ${response.status}`,
    status: response.status,
    method,
    url,
    body: errorBody(await response.bytes(), response.headers.get("content-type")),
    headers: response.headers,
    ...(service !== undefined ? { service } : {}),
  });
}

/** The `INVALID_RESPONSE` error of a JSON response that does not parse. */
export function invalidResponse(method: string, url: string, cause: unknown, service?: string): HttpClientError {
  const masked = maskedUrl(url, currentSettings());
  return new HttpClientError({
    code: "INVALID_RESPONSE",
    message: `${method} ${masked} answered invalid JSON`,
    method,
    url: masked,
    cause,
    ...(service !== undefined ? { service } : {}),
  });
}

/**
 * One outgoing call being built. Every method returns a new builder, so a base builder can be shared; `send()`,
 * `text()`, `bytes()` and `response()` run it.
 */
export class HttpRequestBuilder {
  readonly #spec: CallSpec;
  readonly #binding: ClientBinding;

  constructor(spec: CallSpec, binding: ClientBinding) {
    this.#spec = spec;
    this.#binding = binding;
  }

  #with(changes: Partial<CallSpec>): HttpRequestBuilder {
    return new HttpRequestBuilder({ ...this.#spec, ...changes }, this.#binding);
  }

  /** Sends `body` as JSON with `content-type: application/json`. */
  json(body: unknown): HttpRequestBuilder {
    return this.#with({ body: { kind: "json", value: body } });
  }

  /** Sends a plain object URL-encoded, or a `FormData` as multipart. */
  form(data: Record<string, unknown> | FormData): HttpRequestBuilder {
    return this.#with({ body: { kind: "form", value: data } });
  }

  /** Sends a raw body: a string, bytes, a `Blob` or a stream. */
  body(raw: HttpBody): HttpRequestBuilder {
    return this.#with({ body: { kind: "raw", value: raw } });
  }

  /** Sets one header; a later call for the same name wins. */
  header(name: string, value: string): HttpRequestBuilder {
    return this.#with({ headers: [...this.#spec.headers, [name, value]] });
  }

  /** Sets several headers. */
  headers(record: Readonly<Record<string, string>>): HttpRequestBuilder {
    return this.#with({ headers: [...this.#spec.headers, ...Object.entries(record)] });
  }

  /** Appends query parameters: arrays repeat the name, `undefined` values are skipped. */
  query(record: Readonly<Record<string, HttpQueryValue>>): HttpRequestBuilder {
    const items: [string, string][] = [];
    for (const [name, value] of Object.entries(record)) appendQuery({ append: (key, item) => items.push([key, item]) }, name, value);
    return this.#with({ query: [...this.#spec.query, ...items] });
  }

  /** Sets `authorization: Bearer <token>`. */
  bearer(token: string): HttpRequestBuilder {
    return this.header("authorization", `Bearer ${token}`);
  }

  /** The longest the call may take, reading the body included: a duration like `500ms` or milliseconds. */
  timeout(value: string | number): HttpRequestBuilder {
    timeoutMs(value);
    return this.#with({ timeout: value });
  }

  /** Aborts the call when `signal` aborts, rejecting with `ABORTED`. */
  signal(signal: AbortSignal): HttpRequestBuilder {
    return this.#with({ signal });
  }

  /** Wraps the call in a modifier. */
  use(modifier: HttpModifier): HttpRequestBuilder {
    return this.#with({ modifiers: [...this.#spec.modifiers, modifier] });
  }

  /** Runs the call and resolves its response, whatever the status. */
  response(): Promise<HttpResponse> {
    return execute(this.#spec, this.#binding);
  }

  async #ok(): Promise<HttpResponse> {
    const response = await this.response();
    if (!response.ok) throw await statusError(response, this.#spec.method, undefined);
    return response;
  }

  /**
   * Runs the call and resolves the body of a 2xx response: JSON for JSON content types, `undefined` when empty, the
   * text otherwise; any other status rejects with an `HttpClientError` of code `HTTP_STATUS`.
   */
  async send<T = unknown>(): Promise<NoInfer<T>> {
    const response = await this.#ok();
    return parseBody(await response.bytes(), response.headers.get("content-type"), (cause) => invalidResponse(this.#spec.method, response.url, cause)) as T;
  }

  /** Runs the call and resolves the body of a 2xx response as text. */
  async text(): Promise<string> {
    return (await this.#ok()).text();
  }

  /** Runs the call and resolves the body of a 2xx response as bytes. */
  async bytes(): Promise<Uint8Array> {
    return (await this.#ok()).bytes();
  }
}

/** The methods of a client, each taking an absolute `http` or `https` URL. */
export interface HttpMethods {
  get(url: string | URL): HttpRequestBuilder;
  post(url: string | URL): HttpRequestBuilder;
  put(url: string | URL): HttpRequestBuilder;
  patch(url: string | URL): HttpRequestBuilder;
  delete(url: string | URL): HttpRequestBuilder;
  head(url: string | URL): HttpRequestBuilder;
}

/** The URL of a call; throws for anything but an absolute URL. */
function absoluteUrl(method: string, value: string | URL): URL {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (!url) throw new TypeError(`http.${method.toLowerCase()}() takes an absolute http or https URL, got ${JSON.stringify(String(value))}`);
  return url;
}

/** The six methods of a client bound to `binding`. */
export function methodsOf(binding: ClientBinding): HttpMethods {
  const start = (method: string) => (url: string | URL) => {
    currentSettings();
    return new HttpRequestBuilder({ method, url: absoluteUrl(method, url), headers: [], query: [], modifiers: [] }, binding);
  };
  return { get: start("GET"), post: start("POST"), put: start("PUT"), patch: start("PATCH"), delete: start("DELETE"), head: start("HEAD") };
}

/** The outgoing HTTP client: `http.get(url).send()`. */
export interface Http extends HttpMethods {}

/** The outgoing HTTP client, with the options of the `http` native. */
export const http: Http = methodsOf({});

export { HttpClientError } from "./errors.ts";
export { maskedUrl } from "./transport.ts";
