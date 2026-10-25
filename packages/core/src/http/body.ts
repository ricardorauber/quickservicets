import { HttpError } from "../errors.ts";
import { formatSize } from "../files/limits.ts";

/** How the body of one request may be read; the body readers (`req.json()` and the multipart reader) honor it. */
export interface BodyPolicy {
  /** The most bytes the body may have; a longer body fails with 413 once that many arrived, without reading the rest. */
  maxBytes?: number;
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

/**
 * Reads a request's body chunk by chunk under its policy: counts the bytes as they arrive and fails with 413 once
 * `maxBytes` is passed, cancelling the rest of the body. A body declaring a larger `content-length` fails before it
 * is read.
 */
export async function readBodyChunks(request: Request, onChunk: (chunk: Uint8Array) => void): Promise<void> {
  const policy = policies.get(request);
  const max = policy?.maxBytes;
  if (max !== undefined && Number(request.headers.get("content-length") ?? 0) > max) throw bodyTooLarge(max);
  const stream = request.body?.getReader();
  if (!stream) return;
  let received = 0;
  try {
    for (let chunk = await stream.read(); !chunk.done; chunk = await stream.read()) {
      received += chunk.value.byteLength;
      if (max !== undefined && received > max) throw bodyTooLarge(max);
      onChunk(chunk.value);
    }
  } catch (error) {
    await stream.cancel().catch(() => {});
    throw error;
  }
}

/** The whole body as bytes, read under the request's policy; without a policy, as the runtime reads it. */
export async function readBodyBytes(request: Request): Promise<Uint8Array> {
  if (!policies.has(request)) return request.bytes();
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
  if (!policies.has(request)) return request.text();
  return new TextDecoder().decode(await readBodyBytes(request));
}
