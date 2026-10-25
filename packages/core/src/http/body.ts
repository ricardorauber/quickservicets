import { HttpError } from "../errors.ts";
import { formatSize } from "../files/limits.ts";

/** How the body of one request may be read; the body readers (`req.json()` and the multipart reader) honor it. */
export interface BodyPolicy {
  /** The most bytes the body may have; a longer body fails with 413 once that many arrived, without reading the rest. */
  maxBytes?: number;
  /**
   * Milliseconds the whole body has to arrive in, counted from the first read; a slower body fails with 408 and a
   * response that closes the connection.
   */
  readTimeout?: number;
}

const policies = new WeakMap<Request, BodyPolicy>();

/** Sets (or adds to) the body policy of a request, before its body is read. */
export function setBodyPolicy(request: Request, policy: BodyPolicy): void {
  const current = policies.get(request);
  policies.set(request, current ? { ...current, ...policy } : policy);
}

/** The body policy of a request, if one was set. */
export function bodyPolicyOf(request: Request): BodyPolicy | undefined {
  return policies.get(request);
}

/** The error of a body longer than `maxBytes`: 413 `Request body is larger than <size>`. */
export function bodyTooLarge(maxBytes: number): HttpError {
  return new HttpError(413, `Request body is larger than ${formatSize(maxBytes)}`);
}

/** The error of a body that did not arrive in time: 408, with a response that closes the connection. */
export function bodyTooSlow(): HttpError {
  return new HttpError(408, "Request body was not received in time", { headers: { connection: "close" } });
}

/**
 * Runs a read under the policy's deadline: rejects with the 408 error once `readTimeout` passes, calling `onTimeout`,
 * and clears its timer as soon as the read settles.
 */
async function withinDeadline<T>(policy: BodyPolicy | undefined, read: (expired: () => boolean) => Promise<T>, onTimeout?: () => void): Promise<T> {
  const timeout = policy?.readTimeout;
  if (timeout === undefined || timeout <= 0) return read(() => false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      onTimeout?.();
      reject(bodyTooSlow());
    }, timeout);
  });
  try {
    return await Promise.race([read(() => expired), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads a request's body chunk by chunk under its policy: counts the bytes as they arrive and fails with 413 once
 * `maxBytes` is passed, or with 408 once `readTimeout` passed since the first read, cancelling the rest of the body. A
 * body declaring a larger `content-length` fails before it is read.
 */
export async function readBodyChunks(request: Request, onChunk: (chunk: Uint8Array) => void): Promise<void> {
  const policy = policies.get(request);
  const max = policy?.maxBytes;
  if (max !== undefined && Number(request.headers.get("content-length") ?? 0) > max) throw bodyTooLarge(max);
  const stream = request.body?.getReader();
  if (!stream) return;
  const cancel = () => void stream.cancel().catch(() => {});
  try {
    await withinDeadline(
      policy,
      async (expired) => {
        let received = 0;
        for (let chunk = await stream.read(); !chunk.done && !expired(); chunk = await stream.read()) {
          received += chunk.value.byteLength;
          if (max !== undefined && received > max) throw bodyTooLarge(max);
          onChunk(chunk.value);
        }
      },
      cancel,
    );
  } catch (error) {
    cancel();
    throw error;
  }
}

/** Whether the runtime can read the body at once: no byte limit to count, or a declared length within it. */
function readsAtOnce(request: Request, policy: BodyPolicy): boolean {
  if (policy.maxBytes === undefined) return true;
  const declared = request.headers.get("content-length");
  if (declared === null) return false;
  if (Number(declared) > policy.maxBytes) throw bodyTooLarge(policy.maxBytes);
  return true;
}

/** The whole body as bytes, read under the request's policy; without a policy, as the runtime reads it. */
export async function readBodyBytes(request: Request): Promise<Uint8Array> {
  const policy = policies.get(request);
  if (!policy) return request.bytes();
  if (readsAtOnce(request, policy)) return withinDeadline(policy, () => request.bytes());
  const chunks: Uint8Array[] = [];
  let length = 0;
  await readBodyChunks(request, (chunk) => {
    chunks.push(chunk);
    length += chunk.byteLength;
  });
  if (chunks.length === 1) return chunks[0]!;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The whole body as UTF-8 text, read under the request's policy. */
export async function readBodyText(request: Request): Promise<string> {
  const policy = policies.get(request);
  if (!policy) return request.text();
  if (readsAtOnce(request, policy)) return withinDeadline(policy, () => request.text());
  return new TextDecoder().decode(await readBodyBytes(request));
}
