import { HttpError, toErrorResponse } from "../errors.ts";
import { flushLogs, jsonLogger, safeLog, type Logger } from "../logger.ts";
import { answerPlatformEvent, createServiceHandler, type ServiceHandler, type ServiceHandlerOptions } from "../service-handler.ts";

/** The largest buffered response Lambda returns: 6 MB. */
export const LAMBDA_RESPONSE_LIMIT = 6 * 1024 * 1024;

/** The message of a response over the buffered limit. */
export const LAMBDA_TOO_LARGE = "Response is larger than the 6 MB Lambda limit";

/** The message of an event that is neither HTTP nor a job nor claimed by a source. */
export const UNSUPPORTED_LAMBDA_EVENT = "Unsupported Lambda event";

/** An API Gateway REST (payload 1.0) or Application Load Balancer event. */
interface V1Event {
  httpMethod: string;
  path: string;
  headers?: Record<string, string | undefined> | null;
  multiValueHeaders?: Record<string, (string | undefined)[] | undefined> | null;
  queryStringParameters?: Record<string, string | undefined> | null;
  multiValueQueryStringParameters?: Record<string, (string | undefined)[] | undefined> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: { identity?: { sourceIp?: string }; elb?: unknown };
}

/** An HTTP API or function URL event (payload 2.0). */
interface V2Event {
  version: "2.0";
  rawPath: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string; sourceIp?: string } };
}

/** What a Lambda HTTP event becomes: a standard request, the client address and the format to answer in. */
export interface LambdaRequest {
  request: Request;
  clientIp?: string;
  format: "1.0" | "2.0";
  /** Whether a 1.0 event sent `multiValueHeaders`, so the response carries them too. */
  multiValue: boolean;
}

const isV2 = (event: unknown): event is V2Event => typeof event === "object" && event !== null && (event as V2Event).version === "2.0" && typeof (event as V2Event).requestContext?.http?.method === "string";
const isV1 = (event: unknown): event is V1Event => typeof event === "object" && event !== null && typeof (event as V1Event).httpMethod === "string" && typeof (event as V1Event).path === "string";

/** Whether an event is an HTTP event of API Gateway, an Application Load Balancer or a function URL. */
export const isLambdaHttpEvent = (event: unknown): boolean => isV1(event) || isV2(event);

const bodyOf = (body: string | null | undefined, base64: boolean | undefined): string | Uint8Array<ArrayBuffer> | undefined => {
  if (body === undefined || body === null || body === "") return undefined;
  return base64 ? new Uint8Array(Buffer.from(body, "base64")) : body;
};

/** Converts an HTTP event into a standard `Request`. */
export function lambdaRequest(event: unknown): LambdaRequest {
  if (isV2(event)) {
    const headers = new Headers();
    for (const [name, value] of Object.entries(event.headers ?? {})) if (value !== undefined) headers.set(name, value);
    if (event.cookies?.length) headers.set("cookie", event.cookies.join("; "));
    const host = headers.get("host") ?? "lambda.local";
    const url = `https://${host}${event.rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ""}`;
    const method = event.requestContext.http.method.toUpperCase();
    const body = method === "GET" || method === "HEAD" ? undefined : bodyOf(event.body, event.isBase64Encoded);
    return { request: new Request(url, { method, headers, ...(body !== undefined ? { body } : {}) }), ...(event.requestContext.http.sourceIp ? { clientIp: event.requestContext.http.sourceIp } : {}), format: "2.0", multiValue: false };
  }
  if (!isV1(event)) throw new Error(UNSUPPORTED_LAMBDA_EVENT);
  const headers = new Headers();
  const multiValue = event.multiValueHeaders !== undefined && event.multiValueHeaders !== null;
  if (multiValue) {
    for (const [name, values] of Object.entries(event.multiValueHeaders ?? {})) for (const value of values ?? []) if (value !== undefined) headers.append(name, value);
  } else {
    for (const [name, value] of Object.entries(event.headers ?? {})) if (value !== undefined && value !== null) headers.set(name, value);
  }
  const query = new URLSearchParams();
  if (event.multiValueQueryStringParameters) {
    for (const [name, values] of Object.entries(event.multiValueQueryStringParameters)) for (const value of values ?? []) if (value !== undefined) query.append(name, value);
  } else {
    for (const [name, value] of Object.entries(event.queryStringParameters ?? {})) if (value !== undefined && value !== null) query.append(name, value);
  }
  const host = headers.get("host") ?? "lambda.local";
  const search = query.toString();
  const method = event.httpMethod.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : bodyOf(event.body, event.isBase64Encoded);
  const request = new Request(`https://${host}${event.path}${search ? `?${search}` : ""}`, { method, headers, ...(body !== undefined ? { body } : {}) });
  // An ALB appends the client to x-forwarded-for; API Gateway names it in the request context.
  const forwarded = headers.get("x-forwarded-for")?.split(",").map((entry) => entry.trim()).filter(Boolean).at(-1);
  const clientIp = event.requestContext?.identity?.sourceIp ?? (event.requestContext?.elb !== undefined ? forwarded : undefined) ?? forwarded;
  return { request, ...(clientIp ? { clientIp } : {}), format: "1.0", multiValue };
}

/** Whether a content type is sent as text: text, JSON, XML and form data; anything else is base64. */
export function isTextContent(type: string | null): boolean {
  if (!type) return true;
  const base = type.split(";")[0]!.trim().toLowerCase();
  return base.startsWith("text/") || base === "application/json" || base.endsWith("+json") || base === "application/xml" || base.endsWith("+xml") || base === "application/x-www-form-urlencoded" || base === "multipart/form-data";
}

/** The result a Lambda HTTP integration expects. */
export type LambdaResult = Record<string, unknown> & { statusCode: number };

/** Maps a response to the format of the event's source: headers, cookies and a text or base64 body. */
export async function lambdaResult(response: Response, format: "1.0" | "2.0", multiValue: boolean, body?: Uint8Array): Promise<LambdaResult> {
  const bytes = body ?? new Uint8Array(await response.arrayBuffer());
  const text = isTextContent(response.headers.get("content-type"));
  const encoded = text ? { body: new TextDecoder().decode(bytes), isBase64Encoded: false } : { body: Buffer.from(bytes).toString("base64"), isBase64Encoded: true };
  const headers: Record<string, string> = {};
  const multi: Record<string, string[]> = {};
  for (const [name, value] of response.headers) {
    if (name === "set-cookie") continue;
    headers[name] = value;
    (multi[name] ??= []).push(value);
  }
  const cookies = response.headers.getSetCookie();
  if (format === "2.0") return { statusCode: response.status, headers, ...(cookies.length > 0 ? { cookies } : {}), ...encoded };
  if (multiValue) return { statusCode: response.status, headers, multiValueHeaders: { ...multi, ...(cookies.length > 0 ? { "set-cookie": cookies } : {}) }, ...encoded };
  return { statusCode: response.status, headers: { ...headers, ...(cookies.length > 0 ? { "set-cookie": cookies.join(", ") } : {}) }, ...encoded };
}

/** An event asking the function to run a job: `{ "quickservicets": { "job": "<name>" } }`. */
const jobOf = (event: unknown): string | undefined => {
  const job = (event as { quickservicets?: { job?: unknown } } | null)?.quickservicets?.job;
  return typeof job === "string" ? job : undefined;
};

/** What `runLambda` accepts besides the service's inputs. */
export interface LambdaOptions {
  /** Sends responses with the streaming response mode (function URLs with `RESPONSE_STREAM`). */
  streaming?: boolean;
  /** The Runtime API host (default `AWS_LAMBDA_RUNTIME_API`). */
  runtimeApi?: string;
  /** Answers events no handler claims, before they fail as unsupported (the `onPlatformEvent` hooks). */
  onEvent?: (event: unknown, context: LambdaContext) => Promise<unknown> | unknown;
  /** Stops after this many invocations (default: never), for tests. */
  invocations?: number;
}

/** The context of an invocation. */
export interface LambdaContext {
  awsRequestId: string;
  invokedFunctionArn?: string;
  deadlineMs: number;
  traceId?: string;
}

/** Handles one Lambda invocation: an HTTP event, a job event, or an event `onEvent` answers. */
export async function handleLambdaEvent(handler: ServiceHandler, event: unknown, context: LambdaContext, options: Pick<LambdaOptions, "onEvent"> & { logger?: Logger } = {}): Promise<unknown> {
  // The onPlatformEvent hooks see every non-HTTP event first and may answer it.
  if (!isLambdaHttpEvent(event)) {
    const answer = await answerPlatformEvent(handler.config, "lambda", event);
    if (answer !== undefined) return answer;
  }
  const job = jobOf(event);
  if (job !== undefined) {
    const run = await handler.runJob(job);
    if (run && run.status !== "success") throw new Error(`Job ${job} ${run.status}: ${(run.error as { message?: string } | undefined)?.message ?? ""}`.trim());
    return { status: "completed" };
  }
  if (isLambdaHttpEvent(event)) {
    const { request, clientIp, format, multiValue } = lambdaRequest(event);
    const response = await handler.fetch(request, { name: "lambda", requestId: context.awsRequestId, deadline: context.deadlineMs, event, context, ...(clientIp ? { clientIp } : {}) });
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > LAMBDA_RESPONSE_LIMIT) {
      safeLog(options.logger ?? jsonLogger, "error", { timestamp: new Date().toISOString(), message: "lambda.response.too-large", route: new URL(request.url).pathname, bytes: body.byteLength, requestId: context.awsRequestId });
      return lambdaResult(toErrorResponse(new HttpError(500, LAMBDA_TOO_LARGE), { production: true }), format, multiValue);
    }
    return lambdaResult(new Response(body, { status: response.status, headers: response.headers }), format, multiValue, body);
  }
  if (options.onEvent) {
    const answer = await options.onEvent(event, context);
    if (answer !== undefined) return answer;
  }
  throw new Error(UNSUPPORTED_LAMBDA_EVENT);
}

/** The error document the Runtime API takes. */
const errorBody = (error: unknown) => {
  const failure = error instanceof Error ? error : new Error(String(error));
  return JSON.stringify({ errorMessage: failure.message, errorType: failure.name });
};

/** The delimiter between the prelude and the body of a streamed HTTP response. */
const STREAM_DELIMITER = new Uint8Array(8);

/** Streams an HTTP response through the Runtime API's streaming response mode. */
async function streamResponse(api: string, id: string, handler: ServiceHandler, event: unknown, context: LambdaContext): Promise<void> {
  const { request, clientIp } = lambdaRequest(event);
  const response = await handler.fetch(request, { name: "lambda", requestId: context.awsRequestId, deadline: context.deadlineMs, event, context, ...(clientIp ? { clientIp } : {}) });
  const headers: Record<string, string> = {};
  for (const [name, value] of response.headers) if (name !== "set-cookie") headers[name] = value;
  const cookies = response.headers.getSetCookie();
  const prelude = new TextEncoder().encode(JSON.stringify({ statusCode: response.status, headers, ...(cookies.length > 0 ? { cookies } : {}) }));
  const source = response.body;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(prelude);
      controller.enqueue(STREAM_DELIMITER);
      if (source) for await (const chunk of source as unknown as AsyncIterable<Uint8Array>) controller.enqueue(chunk);
      controller.close();
    },
  });
  await fetch(`http://${api}/2018-06-01/runtime/invocation/${id}/response`, {
    method: "POST",
    headers: { "Lambda-Runtime-Function-Response-Mode": "streaming", "Content-Type": "application/vnd.awslambda.http-integration-response" },
    body,
  });
}

/**
 * The Lambda Runtime API loop of the `lambda` target's bootstrap: initializes the service once (reporting a failure to
 * the init error endpoint), then fetches each invocation, passes it to the platform handler with its request id and
 * deadline, and posts the result or the error.
 */
export async function runLambda(inputs: ServiceHandlerOptions, options: LambdaOptions = {}): Promise<void> {
  const api = options.runtimeApi ?? process.env.AWS_LAMBDA_RUNTIME_API;
  if (!api) throw new Error("AWS_LAMBDA_RUNTIME_API is not set; the lambda bootstrap runs inside AWS Lambda or against a Runtime API");
  const base = `http://${api}/2018-06-01/runtime`;
  const handler = createServiceHandler({ ...inputs, scheduledWork: false, handleSigterm: false });
  // Lambda sends SIGTERM before it shuts an instance down: the service stops and the process exits.
  const onSigterm = () => void handler.stop().finally(() => process.exit(0));
  if (inputs.handleSigterm !== false) process.once("SIGTERM", onSigterm);
  try {
    await handler.init();
  } catch (error) {
    await fetch(`${base}/init/error`, { method: "POST", headers: { "Lambda-Runtime-Function-Error-Type": "Runtime.InitError" }, body: errorBody(error) });
    flushLogs();
    process.exit(1);
  }
  for (let served = 0; options.invocations === undefined || served < options.invocations; served++) {
    const next = await fetch(`${base}/invocation/next`);
    const id = next.headers.get("lambda-runtime-aws-request-id") ?? "";
    const context: LambdaContext = {
      awsRequestId: id,
      deadlineMs: Number(next.headers.get("lambda-runtime-deadline-ms") ?? Date.now() + 900_000),
      ...(next.headers.get("lambda-runtime-invoked-function-arn") ? { invokedFunctionArn: next.headers.get("lambda-runtime-invoked-function-arn")! } : {}),
      ...(next.headers.get("lambda-runtime-trace-id") ? { traceId: next.headers.get("lambda-runtime-trace-id")! } : {}),
    };
    let event: unknown;
    try {
      event = await next.json();
    } catch {
      event = undefined;
    }
    try {
      if (options.streaming && isLambdaHttpEvent(event)) {
        await streamResponse(api, id, handler, event, context);
        continue;
      }
      const result = await handleLambdaEvent(handler, event, context, options.onEvent ? { onEvent: options.onEvent } : {});
      await fetch(`${base}/invocation/${id}/response`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(result) });
    } catch (error) {
      await fetch(`${base}/invocation/${id}/error`, { method: "POST", headers: { "Lambda-Runtime-Function-Error-Type": "Runtime.HandlerError" }, body: errorBody(error) });
    }
  }
  process.off("SIGTERM", onSigterm);
  await handler.stop();
}
