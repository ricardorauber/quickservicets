import { createHmac, timingSafeEqual } from "node:crypto";

/** The key bytes of a secret: the base64 after `whsec_`, or the whole text's bytes for a secret without the prefix. */
function keyOf(secret: string): Buffer {
  return secret.startsWith("whsec_") ? Buffer.from(secret.slice(6), "base64") : Buffer.from(secret, "utf8");
}

/** What `signWebhook` signs: the message id, its unix timestamp in seconds and the exact body text. */
export interface SignInput {
  id: string;
  timestamp: number | string;
  body: string;
  secret: string;
}

/**
 * The Standard Webhooks signature of a message: `v1,` and the base64 of the HMAC-SHA256 of `<id>.<timestamp>.<body>`,
 * keyed with the secret's bytes (the base64 after `whsec_`).
 */
export function signWebhook({ id, timestamp, body, secret }: SignInput): string {
  return `v1,${createHmac("sha256", keyOf(secret)).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

/** What `verifyWebhook` checks: the message and the `webhook-signature` header against every accepted secret. */
export interface VerifyInput {
  id: string;
  timestamp: number | string;
  body: string;
  /** The `webhook-signature` header: space-separated `v1,<base64>` signatures. */
  signature: string;
  secrets: readonly string[];
}

/** Whether any `v1,` signature of the header matches the message under any of the secrets, compared in constant time. */
export function verifyWebhook({ id, timestamp, body, signature, secrets }: VerifyInput): boolean {
  const given = String(signature ?? "")
    .split(" ")
    .map((item) => item.trim())
    .filter((item) => item.startsWith("v1,"))
    .map((item) => Buffer.from(item.slice(3), "base64"));
  if (given.length === 0) return false;
  let matched = false;
  for (const secret of secrets) {
    const expected = Buffer.from(signWebhook({ id, timestamp, body, secret }).slice(3), "base64");
    for (const candidate of given) {
      // Every comparison runs, so the time does not tell which secret or signature matched.
      if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) matched = true;
    }
  }
  return matched;
}
