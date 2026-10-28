import { coreInstruments, currentTenant, DEFAULT_MASKED_KEYS, formatTraceparent, metricsEnabled, tenantAttributes, spanAttributes, startSpan, tracingEnabled, withSpan, jsonLogger, lastResolvedFeatures, OptionError, parseDuration, resolveOption, resolveOptions, runAfterHooks, runBeforeHooks, type FeatureHook, type Logger, type OptionFunction, type ServiceRequest } from "../public.ts";
import { HttpClientError } from "./errors.ts";
import { httpOptions, serviceProblems, type HttpOptions, type ServiceOptions } from "./options.ts";
import { sharedState } from "./state.ts";
import { runChain } from "./modifiers.ts";
import { withRetry, type RetryOptions } from "./retry.ts";
import { withCache, type CacheOptions } from "./cache.ts";
import { mockHttp, type HttpMock } from "./mock.ts";
import { stateOf, withBulkhead, withCircuitBreaker, type BulkheadOptions, type CircuitBreakerOptions, type HttpState } from "./resilience.ts";
import { maskedUrl, StreamedResponse, streamTransport, transport } from "./transport.ts";
import type { ServiceTls } from "./service-tls.ts";

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
  /** The named service the call goes through. */
  service?: string;
}

/** Who a client calls for: the global client calls for nobody. */
export interface ClientBinding {
  /** Sent as `x-request-id` unless the call sets it. */
  requestId?: string;
  /** The request whose user, tenant and credentials calls through services propagate. */
  req?: ServiceRequest;
}

/** A named service, from the config or added by a feature. */
export interface ServiceSettings extends ServiceOptions {
  name: string;
  /** Who declared it: `http.services` or the key of the feature that added it. */
  owner: string;
  /** The host (and port) of its base URL, which SSRF protection trusts for calls through the service. */
  host: string;
}

/** The runtime settings of the running native, installed by its setup. */
export interface RunningHttp {
  options: HttpOptions;
  logger: Logger;
  production: boolean;
  /** The query parameter names whose values are masked in logged and reported URLs. */
  maskKeys: readonly string[];
  /** The named services, by name. */
  services: ReadonlyMap<string, ServiceSettings>;
  /** The named modifiers services list, by name, with who registered each. */
  modifiers: ReadonlyMap<string, RegisteredModifier>;
  /** The TLS material of the services with `tls`, by name, read at startup and swapped when the files change. */
  tls?: ReadonlyMap<string, ServiceTls>;
}

/** A named modifier and who registered it: `http` for the built-in ones, else a feature's key. */
export interface RegisteredModifier {
  owner: string;
  modifier: HttpModifier;
}

/** The built-in named modifiers, with their default options. */
export function builtInModifiers(): Map<string, RegisteredModifier> {
  return new Map([
    ["retry", { owner: "http", modifier: withRetry() }],
    ["circuitBreaker", { owner: "http", modifier: withCircuitBreaker() }],
    ["bulkhead", { owner: "http", modifier: withBulkhead() }],
    ["cache", { owner: "http", modifier: withCache() }],
  ]);
}

/** The services of the config's `http.services`, by name. */
export function configServices(options: HttpOptions): Map<string, ServiceSettings> {
  const services = new Map<string, ServiceSettings>();
  for (const [name, service] of Object.entries(options.services as Record<string, ServiceOptions>)) services.set(name, serviceSettings(name, "http.services", service));
  return services;
}

/** A service's settings from its resolved options. */
export function serviceSettings(name: string, owner: string, service: ServiceOptions): ServiceSettings {
  // The options object keeps its masking of secrets: the settings read through it.
  return Object.assign(Object.create(service) as ServiceOptions, { name, owner, host: new URL(service.url).host.toLowerCase() }) as ServiceSettings;
}

const derivedServices = new WeakMap<object, Map<string, ServiceSettings>>();

/** The settings every call reads. */
export type HttpSettings = RunningHttp;

/** The running native of this process, or undefined until a service with it starts. */
export const running = sharedState("running", () => ({ current: undefined as RunningHttp | undefined }));

/** The error of every call while the native is turned off. */
export const DISABLED = "http is disabled (http: false in quickservicets.config.ts)";

const defaults = sharedState("defaults", () => ({ options: undefined as HttpOptions | undefined, modifiers: undefined as Map<string, RegisteredModifier> | undefined }));

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
  let services = derivedServices.get(options);
  if (!services) derivedServices.set(options, (services = configServices(options)));
  return { options, logger: jsonLogger, production: false, maskKeys: DEFAULT_MASKED_KEYS, services, modifiers: (defaults.modifiers ??= builtInModifiers()) };
}

/** Milliseconds of a duration or a number of milliseconds; throws for anything else. */
export function timeoutMs(value: number | string): number {
  const ms = typeof value === "number" ? value : parseDuration(value);
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) throw new TypeError(`Invalid timeout ${JSON.stringify(value)}: expected milliseconds or a duration like 500ms or 10s`);
  return ms;
}

/** The request a call spec describes, with its headers, query and body applied. */
export async function describeCall(spec: CallSpec, settings: HttpSettings, binding: ClientBinding): Promise<HttpRequest> {
  const url = new URL(spec.url);
  for (const [name, value] of spec.query) url.searchParams.append(name, value);
  const headers = new Headers({ "user-agent": settings.options.userAgent });
  if (binding.requestId !== undefined) headers.set("x-request-id", binding.requestId);
  const service = spec.service === undefined ? undefined : serviceNamed(spec.service, settings);
  if (service) await applyService(headers, service, binding);
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
    timeout: timeoutMs(spec.timeout ?? service?.timeout ?? settings.options.timeout),
    signal: spec.signal,
    attempt: 1,
    ...(spec.service !== undefined ? { service: spec.service } : {}),
  };
}

/** Adds what a service sends with every call: its headers, its authentication and the request values it propagates. */
async function applyService(headers: Headers, service: ServiceSettings, binding: ClientBinding, propagateValues = true): Promise<void> {
  // Headers and authentication may be functions of the request, called on every call through the service.
  const context = { req: binding.req, user: binding.req?.user, tenant: binding.req?.tenant, service: service.name };
  const serviceHeaders = (await resolveOption(service.headers as ServiceHeaders, context)) as Record<string, string> | undefined;
  for (const [name, value] of Object.entries(serviceHeaders ?? {})) headers.set(name, value);
  const auth = (await resolveOption(service.auth as ServiceAuth, context)) as ResolvedAuth | undefined;
  const problems = typeof service.auth === "function" ? serviceProblems(service.name, { auth } as never) : [];
  if (problems.length > 0) throw new OptionError(problems.join("\n"));
  if (auth?.bearer !== undefined) headers.set("authorization", `Bearer ${auth.bearer}`);
  else if (auth?.basic !== undefined) headers.set("authorization", `Basic ${btoa(`${auth.basic.username}:${auth.basic.password}`)}`);
  else if (auth?.apiKey !== undefined) headers.set(auth.apiKey.header, auth.apiKey.value);
  if (!propagateValues) return;
  // Only calls through a service bound to a request carry who the request is for.
  if (binding.req) propagate(headers, service.propagate, binding.req);
  else if (service.propagate.includes("tenant")) {
    // A job or consumer running for a tenant carries it like a request of that tenant would.
    const tenant = currentTenant();
    if (tenant) headers.set("x-tenant-id", tenant.id);
  }
}

/** Sets the propagated request values a service asks for, each only when the request has it. */
function propagate(headers: Headers, what: readonly string[], req: ServiceRequest): void {
  const idOf = (value: unknown) => {
    const id = (value as { id?: unknown } | undefined)?.id;
    return id === undefined || id === null ? undefined : String(id);
  };
  const values: [string, string | undefined][] = [
    ["x-user-id", what.includes("user") ? idOf(req.user) : undefined],
    ["x-tenant-id", what.includes("tenant") ? idOf(req.tenant) : undefined],
    ["authorization", what.includes("authorization") ? (req.headers.get("authorization") ?? undefined) : undefined],
  ];
  for (const [name, value] of values) if (value !== undefined) headers.set(name, value);
}

function appendQuery(target: { append(name: string, value: string): void }, name: string, value: HttpQueryValue): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) for (const item of value) target.append(name, String(item));
  else target.append(name, String(value));
}

/** Runs a call: the modifiers, then the transport. */
export async function execute(spec: CallSpec, binding: ClientBinding): Promise<HttpResponse> {
  const settings = currentSettings();
  const request = await describeCall(spec, settings, binding);
  const service = spec.service === undefined ? undefined : serviceNamed(spec.service, settings);
  // A call through a service trusts the service's own host; any other host is checked as usual.
  const trustedHost = service?.host;
  const chain = [...(service ? serviceModifiers(service, settings) : []), ...spec.modifiers];
  const sendOne = (changed: HttpRequest) => transport(changed, settings, trustedHost);
  // With a tracer, each attempt runs in a client span whose context the call carries as `traceparent`.
  // With a meter, each attempt's duration is recorded.
  const attemptOf = (changed: HttpRequest) => (tracingEnabled() ? tracedAttempt(changed, settings, sendOne) : sendOne(changed));
  const send = (attempt: HttpRequest) => withHooks(attempt, settings, (changed) => (metricsEnabled() ? measuredAttempt(changed, () => attemptOf(changed)) : attemptOf(changed)));
  return chain.length === 0 ? send(request) : runChain(chain, request, send, () => maskedUrl(request.url, settings));
}

/** Sends one attempt and records its duration as `http.client.request.duration`, with the status or the error code. */
async function measuredAttempt(request: HttpRequest, send: () => Promise<HttpResponse>): Promise<HttpResponse> {
  const started = performance.now();
  const attributes: Record<string, string | number> = { "http.request.method": request.method, "server.address": new URL(request.url).hostname };
  if (request.service !== undefined) attributes["quickservicets.http.service"] = request.service;
  const record = () => coreInstruments().clientDuration.record((performance.now() - started) / 1000, { ...attributes, ...tenantAttributes(currentTenant()?.id) });
  try {
    const response = await send();
    attributes["http.response.status_code"] = response.status;
    record();
    return response;
  } catch (error) {
    if (error instanceof HttpClientError) {
      attributes["error.type"] = error.code;
      if (error.status) attributes["http.response.status_code"] = error.status;
    } else attributes["error.type"] = error instanceof Error ? error.name : "Error";
    record();
    throw error;
  }
}

/**
 * Sends one attempt in a `client` span named after the method, following the OpenTelemetry HTTP conventions, and adds
 * `traceparent` (and `tracestate`) with the span's context unless the call sets them; network errors, timeouts and
 * statuses of 400 and above set the status `error`.
 */
async function tracedAttempt(request: HttpRequest, settings: HttpSettings, send: (request: HttpRequest) => Promise<HttpResponse>): Promise<HttpResponse> {
  const url = new URL(request.url);
  const scheme = url.protocol.replace(/:$/, "");
  const span = startSpan(request.method, {
    kind: "client",
    attributes: spanAttributes({
      "http.request.method": request.method,
      "server.address": url.hostname,
      "server.port": url.port === "" ? (scheme === "https" ? 443 : 80) : Number(url.port),
      "url.full": maskedUrl(request.url, settings),
      "http.request.resend_count": request.attempt > 1 ? request.attempt - 1 : undefined,
      "quickservicets.http.service": request.service,
    }),
  });
  let sent = request;
  if (!request.headers.has("traceparent")) {
    const context = span.context();
    const headers = new Headers(request.headers);
    headers.set("traceparent", formatTraceparent(context));
    if (context.traceState !== undefined && !headers.has("tracestate")) headers.set("tracestate", context.traceState);
    sent = { ...request, headers };
  }
  try {
    const response = await withSpan(span, () => send(sent));
    span.setAttribute("http.response.status_code", response.status);
    if (response.status >= 400) span.setStatus("error");
    return response;
  } catch (error) {
    if (error instanceof HttpClientError) {
      span.setAttribute("error.type", error.code);
      if (error.status) span.setAttribute("http.response.status_code", error.status);
    }
    span.recordException(error);
    span.setStatus("error");
    throw error;
  } finally {
    span.end();
  }
}

/** What `streamCall` sends: a request of a named service whose body and response are streamed. */
export interface StreamCallSpec {
  method: string;
  /** The absolute URL, on the service's origin. */
  url: string;
  headers: Headers;
  body?: HttpBody;
  /** The named service the call goes through: its headers, authentication, modifiers and trusted host. */
  service: string;
  /** Milliseconds until the response headers. */
  timeout: number;
  /** Milliseconds between body chunks. */
  idleTimeout: number;
  signal?: AbortSignal;
  /** The request the call is made for, which the service's header and authentication functions receive. */
  req?: ServiceRequest;
}

/**
 * Sends a call through a named service without buffering either body: the service's headers, authentication and
 * modifiers apply (retries skip streamed bodies), SSRF protection trusts the service's host, and the upstream's
 * response comes back with its status, headers and a streaming body, redirects included. Failures reject with
 * `HttpClientError` (`TIMEOUT` before the headers, `NETWORK`, `SSRF_BLOCKED`, `CIRCUIT_OPEN`, `BULKHEAD_FULL`).
 */
export async function streamCall(spec: StreamCallSpec): Promise<Response> {
  const settings = currentSettings();
  const service = serviceNamed(spec.service, settings);
  const headers = new Headers(spec.headers);
  await applyService(headers, service, spec.req ? { req: spec.req } : {}, false);
  const request: HttpRequest = { method: spec.method, url: spec.url, headers, body: spec.body, timeout: spec.timeout, signal: spec.signal, attempt: 1, service: service.name };
  const sendOne = (changed: HttpRequest) => streamTransport(changed, settings, service.host, spec.idleTimeout);
  const attemptOf = (changed: HttpRequest) => (tracingEnabled() ? tracedAttempt(changed, settings, sendOne) : sendOne(changed));
  const send = (attempt: HttpRequest) => withHooks(attempt, settings, (changed) => (metricsEnabled() ? measuredAttempt(changed, () => attemptOf(changed)) : attemptOf(changed)));
  const chain = serviceModifiers(service, settings);
  const response = chain.length === 0 ? await send(request) : await runChain(chain, request, send, () => maskedUrl(request.url, settings));
  if (response instanceof StreamedResponse) return response.raw;
  // A modifier answered from elsewhere (a cache): its body is already read.
  return new Response((await response.bytes()) as unknown as ConstructorParameters<typeof Response>[0], { status: response.status, headers: response.headers });
}

/**
 * One attempt with the hooks around it: `beforeRequest` may change the request or cancel the call, `afterResponse`
 * observes each response and `onError` each failure; a failing after-hook is logged and changes nothing.
 */
async function withHooks(request: HttpRequest, settings: HttpSettings, send: (request: HttpRequest) => Promise<HttpResponse>): Promise<HttpResponse> {
  const { beforeRequest, afterResponse, onError } = settings.options as HttpOptions & HookLists;
  const changed = beforeRequest.length > 0 ? await runBeforeHooks(beforeRequest, request, undefined) : request;
  if (afterResponse.length === 0 && onError.length === 0) return send(changed);
  const started = performance.now();
  try {
    const response = await send(changed);
    await runAfterHooks(afterResponse, { request: changed, response, durationMs: performance.now() - started }, undefined);
    return response;
  } catch (error) {
    if (error instanceof HttpClientError) await runAfterHooks(onError, { request: changed, error }, undefined);
    throw error;
  }
}

/** The hook lists of the resolved options. */
interface HookLists {
  beforeRequest: FeatureHook<HttpRequest, undefined>[];
  afterResponse: FeatureHook<{ request: HttpRequest; response: HttpResponse; durationMs: number }, undefined>[];
  onError: FeatureHook<{ request: HttpRequest; error: HttpClientError }, undefined>[];
}

type ServiceHeaders = Record<string, string> | undefined | OptionFunction<Record<string, string> | undefined>;
type ResolvedAuth = { bearer?: string; basic?: { username: string; password: string }; apiKey?: { header: string; value: string } };
type ServiceAuth = ResolvedAuth | undefined | OptionFunction<ResolvedAuth | undefined>;

const builtInChains = new WeakMap<ServiceSettings, HttpModifier[]>();

/**
 * The modifiers of a service, outermost first: its built-in ones in the fixed order retry, circuitBreaker, bulkhead
 * and cache, then its `modifiers` list in order.
 */
export function serviceModifiers(service: ServiceSettings, settings: HttpSettings): HttpModifier[] {
  let builtIn = builtInChains.get(service);
  if (!builtIn) {
    builtIn = [];
    const retry = service.retry as (Record<string, unknown> & { enabled: boolean }) | undefined;
    if (retry?.enabled) builtIn.push(withRetry(retry as RetryOptions));
    const circuitBreaker = service.circuitBreaker as (Record<string, unknown> & { enabled: boolean }) | undefined;
    if (circuitBreaker?.enabled) builtIn.push(withCircuitBreaker(circuitBreaker as CircuitBreakerOptions));
    const bulkhead = service.bulkhead as (Record<string, unknown> & { enabled: boolean }) | undefined;
    if (bulkhead?.enabled) builtIn.push(withBulkhead(bulkhead as BulkheadOptions));
    const cache = service.cache as (Record<string, unknown> & { enabled: boolean }) | undefined;
    if (cache?.enabled) builtIn.push(withCache(cache as CacheOptions));
    builtInChains.set(service, builtIn);
  }
  const named = (service.modifiers as readonly string[] | undefined) ?? [];
  return [...builtIn, ...named.map((name) => modifierNamed(name, service.name, settings).modifier)];
}

/** A registered modifier; throws naming the service and the registered names for an unknown one. */
export function modifierNamed(name: string, service: string, settings: HttpSettings): RegisteredModifier {
  const registered = settings.modifiers.get(name);
  if (!registered) throw new Error(`Unknown modifier ${name} in http.services.${service}.modifiers (registered: ${[...settings.modifiers.keys()].join(", ")})`);
  return registered;
}

/** The service of a name; throws for a name nobody declared. */
export function serviceNamed(name: string, settings: HttpSettings = currentSettings()): ServiceSettings {
  const service = settings.services.get(name);
  if (!service) throw new Error(`Unknown service ${name}; add it to http.services in quickservicets.config.ts`);
  return service;
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
    if (!response.ok) throw await statusError(response, this.#spec.method, this.#spec.service);
    return response;
  }

  /**
   * Runs the call and resolves the body of a 2xx response: JSON for JSON content types, `undefined` when empty, the
   * text otherwise; any other status rejects with an `HttpClientError` of code `HTTP_STATUS`.
   */
  async send<T = unknown>(): Promise<NoInfer<T>> {
    const response = await this.#ok();
    return parseBody(await response.bytes(), response.headers.get("content-type"), (cause) => invalidResponse(this.#spec.method, response.url, cause, this.#spec.service)) as T;
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

/**
 * The service names `http.service()` takes: those of `http.services`, filled in by the build, and the
 * `<feature>/<name>` services features add.
 */
export interface HttpServiceNames {}

/** A name `http.service()` takes. */
export type ServiceName = Extract<keyof HttpServiceNames, string> | `${string}/${string}`;

/** The methods of a service client, each taking a path that starts with `/`. */
export interface HttpServiceMethods {
  get(path: string): HttpRequestBuilder;
  post(path: string): HttpRequestBuilder;
  put(path: string): HttpRequestBuilder;
  patch(path: string): HttpRequestBuilder;
  delete(path: string): HttpRequestBuilder;
  head(path: string): HttpRequestBuilder;
}

/** A path joined to a base URL: `https://api.x/v1` and `/invoices?x=1` give `https://api.x/v1/invoices?x=1`. */
export function joinPath(base: string, path: string): URL {
  const url = new URL(base);
  const joined = new URL(path, "http://path.invalid");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${joined.pathname}`;
  url.search = joined.search;
  url.hash = "";
  return url;
}

/** The base URL of a named service of the running configuration; throws for a name nobody declared. */
export function serviceUrl(name: string): string {
  return serviceNamed(name).url;
}

/** The six methods of the client of service `name`, bound to `binding`. */
export function serviceMethodsOf(name: string, binding: ClientBinding): HttpServiceMethods {
  const service = serviceNamed(name);
  const start = (method: string) => (path: string) => {
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) throw new TypeError(`http.service("${name}") takes a path starting with /, got ${String(path)}`);
    return new HttpRequestBuilder({ method, url: joinPath(serviceNamed(name).url, path), headers: [], query: [], modifiers: [], service: service.name }, binding);
  };
  return { get: start("GET"), post: start("POST"), put: start("PUT"), patch: start("PATCH"), delete: start("DELETE"), head: start("HEAD") };
}

/** The outgoing HTTP client: `http.get(url).send()`, or `http.service(name).get(path).send()`. */
export interface Http extends HttpMethods {
  /** The client of a named service: paths join its base URL, and calls carry its headers, authentication and timeout. */
  service(name: ServiceName): HttpServiceMethods;
  /** The circuit breaker and bulkhead state of a name (a service's, by default) in this worker. */
  state(name: string): HttpState;
  /**
   * Answers every outgoing call of the process from canned handlers until `restore()`, for tests; throws while
   * another mock is active.
   */
  mock(): HttpMock;
}

/** A client bound to `binding`. */
export function clientOf(binding: ClientBinding): Http {
  return { ...methodsOf(binding), service: (name) => serviceMethodsOf(name, binding), state: stateOf, mock: mockHttp };
}

const created = sharedState("request-clients", () => ({ count: 0 }));

/** `req.http`: a client bound to the request, created when the request first reads it. */
export function requestClient(req: ServiceRequest): Http {
  created.count++;
  return clientOf({ requestId: req.id, req });
}

/** How many request-bound clients this process created; for tests. */
export function requestClientsCreated(): number {
  return created.count;
}

/** The outgoing HTTP client, with the options of the `http` native. */
export const http: Http = clientOf({});

export { HttpClientError } from "./errors.ts";
export { maskedUrl } from "./transport.ts";
