import { S3Client } from "bun";
import { assertSafeKey, type StorageAdapter } from "./storage.ts";

export interface S3StorageOptions {
  bucket: string;
  region?: string;
  /** S3-compatible endpoint, e.g. Cloudflare R2 or MinIO. */
  endpoint?: string;
  /** Credentials; when omitted, the S3_* / AWS_* environment variables read by Bun.S3Client are used. */
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Base URL that serves the bucket, enabling `publicUrl`. */
  publicBaseUrl?: string;
}

export function s3Storage(options: S3StorageOptions): StorageAdapter {
  const { publicBaseUrl, ...explicit } = options;
  const env = process.env;
  const fallback = (...names: string[]) => names.map((name) => env[name]).find((value) => value !== undefined && value !== "");
  const clientOptions = {
    ...explicit,
    accessKeyId: explicit.accessKeyId ?? fallback("S3_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"),
    secretAccessKey: explicit.secretAccessKey ?? fallback("S3_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"),
    region: explicit.region ?? fallback("S3_REGION", "AWS_REGION"),
    endpoint: explicit.endpoint ?? fallback("S3_ENDPOINT", "AWS_ENDPOINT"),
  };
  const client = new S3Client(Object.fromEntries(Object.entries(clientOptions).filter(([, value]) => value !== undefined)));
  const storage: StorageAdapter = {
    async put(key, body, { contentType }) {
      assertSafeKey(key);
      await client.write(key, body instanceof ReadableStream ? new Response(body) : (body as Blob), { type: contentType });
    },
    async get(key) {
      assertSafeKey(key);
      const file = client.file(key);
      return (await file.exists()) ? file.stream() : null;
    },
    async delete(key) {
      assertSafeKey(key);
      await client.delete(key);
    },
    signedUrl(key, ttlSeconds) {
      assertSafeKey(key);
      return client.presign(key, { method: "GET", expiresIn: ttlSeconds });
    },
  };
  if (publicBaseUrl) {
    const base = publicBaseUrl.replace(/\/+$/, "");
    storage.publicUrl = (key) => {
      assertSafeKey(key);
      return `${base}/${key}`;
    };
  }
  return storage;
}
