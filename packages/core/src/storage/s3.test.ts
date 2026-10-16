import { expect, test } from "bun:test";
import { runStorageContract } from "../testing/storage-contract.ts";
import { s3Storage } from "./s3.ts";

const bucket = process.env.TEST_S3_BUCKET;
const connection = {
  endpoint: process.env.TEST_S3_ENDPOINT,
  accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY,
  region: process.env.TEST_S3_REGION ?? "us-east-1",
};

if (bucket) {
  const prefix = `contract-${Bun.randomUUIDv7()}`;
  runStorageContract("s3", () => {
    const storage = s3Storage({ bucket, ...connection });
    const scoped = (key: string) => (key.startsWith("/") || key.includes("..") || key === "" || key.includes("/./") ? key : `${prefix}/${key}`);
    return {
      put: (key, body, options) => storage.put(scoped(key), body, options),
      get: (key) => storage.get(scoped(key)),
      delete: (key) => storage.delete(scoped(key)),
    };
  });

  test("a presigned URL downloads the object and carries its expiry", async () => {
    const storage = s3Storage({ bucket, ...connection });
    const key = `${prefix}/signed.txt`;
    await storage.put(key, "signed", { contentType: "text/plain", size: 6 });
    const url = await storage.signedUrl!(key, 60);
    expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe("60");
    expect(await (await fetch(url)).text()).toBe("signed");
    await storage.delete(key);
  });
} else {
  test.skip("S3 storage contract (set TEST_S3_BUCKET to run)", () => {});
}

test("presigned URLs carry the requested expiry without network access", async () => {
  const storage = s3Storage({ bucket: "b", endpoint: "http://localhost:9", accessKeyId: "k", secretAccessKey: "s", region: "us-east-1" });
  const url = new URL(await storage.signedUrl!("media/1/a.png", 60));
  expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
  expect(url.pathname).toContain("media/1/a.png");
});

test("publicUrl exists only with publicBaseUrl", () => {
  expect(s3Storage({ bucket: "b" }).publicUrl).toBeUndefined();
  expect(s3Storage({ bucket: "b", publicBaseUrl: "https://cdn.x" }).publicUrl!("a/b.png")).toBe("https://cdn.x/a/b.png");
});

test("credentials come from options or the environment", async () => {
  const fromOptions = new URL(await s3Storage({ bucket: "b", endpoint: "http://localhost:9", accessKeyId: "option-key", secretAccessKey: "s" }).signedUrl!("k", 10));
  expect(fromOptions.searchParams.get("X-Amz-Credential")).toStartWith("option-key/");
  const previous = { key: process.env.S3_ACCESS_KEY_ID, secret: process.env.S3_SECRET_ACCESS_KEY };
  process.env.S3_ACCESS_KEY_ID = "env-key";
  process.env.S3_SECRET_ACCESS_KEY = "env-secret";
  try {
    const fromEnv = new URL(await s3Storage({ bucket: "b", endpoint: "http://localhost:9" }).signedUrl!("k", 10));
    expect(fromEnv.searchParams.get("X-Amz-Credential")).toStartWith("env-key/");
  } finally {
    if (previous.key === undefined) delete process.env.S3_ACCESS_KEY_ID;
    else process.env.S3_ACCESS_KEY_ID = previous.key;
    if (previous.secret === undefined) delete process.env.S3_SECRET_ACCESS_KEY;
    else process.env.S3_SECRET_ACCESS_KEY = previous.secret;
  }
});
