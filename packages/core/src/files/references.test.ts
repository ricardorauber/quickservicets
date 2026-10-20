import { describe, expect, test } from "bun:test";
import type { ServiceRequest } from "../hooks.ts";
import type { EntityModel } from "../model.ts";
import { fileSamples } from "../testing/file-samples.ts";
import { parseEntityUpload } from "./references.ts";

const BOUNDARY = "entity-boundary";

/** A request with one file part of `size` bytes for `field`, recording whether its body was read at once or streamed. */
function upload(field: string, size: number) {
  const file = new Uint8Array(size);
  file.set(fileSamples.png);
  const body = new Uint8Array(
    Buffer.concat([
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="title"\r\n\r\nHello\r\n`),
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${field}"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
      file,
      Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
    ]),
  );
  const raw = new Request("http://x/posts", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}`, "content-length": String(body.length) },
    body,
  });
  const reads: string[] = [];
  const spy = {
    headers: raw.headers,
    get body() {
      reads.push("stream");
      return raw.body;
    },
    bytes() {
      reads.push("bytes");
      return raw.bytes();
    },
  };
  return { req: { headers: raw.headers, raw: spy } as unknown as ServiceRequest, reads };
}

describe("entity uploads", () => {
  const image = { key: "Image", fields: [], file: { base: "media" } } as unknown as EntityModel;
  const post = {
    key: "Post",
    fields: [
      { name: "title", type: "string" },
      { name: "cover", type: "ref", target: "Image", fileLimits: { maxSize: 512 * 1024 } },
      { name: "gallery", type: "refArray", target: "Image", fileLimits: { maxSize: 256 * 1024 } },
      { name: "author", type: "ref", target: "User" },
    ],
  } as unknown as EntityModel;
  const models = [image, post, { key: "User", fields: [] } as unknown as EntityModel];
  const settings = { storage: {}, files: { maxSize: 10 * 1024 * 1024, accept: ["*/*"] } };

  test("a body within the largest file limit of the entity's file fields is read at once", async () => {
    // 400 KiB is past the allowance alone, and within the cover's limit, the largest of the two file fields.
    const cover = upload("cover", 400 * 1024);
    const parsed = await parseEntityUpload(cover.req, post, models, settings);
    expect(cover.reads).toEqual(["bytes"]);
    expect([parsed.data, parsed.files[0]!.field.name, parsed.files[0]!.files[0]!.size]).toEqual([{ title: "Hello" }, "cover", 400 * 1024]);

    // Past that limit and its allowance, the body streams and the rules answer as before.
    const tooLarge = upload("cover", 600 * 1024);
    const error = await parseEntityUpload(tooLarge.req, post, models, settings).catch((failure: unknown) => failure);
    expect(tooLarge.reads).toEqual(["stream"]);
    expect(error).toMatchObject({ status: 413, details: [{ field: "cover", message: "File too large" }] });

    // An entity without file fields keeps only the allowance.
    const plain = { key: "Note", fields: [{ name: "cover", type: "ref", target: "User" }] } as unknown as EntityModel;
    const note = upload("cover", 100 * 1024);
    await parseEntityUpload(note.req, plain, models, settings).catch(() => undefined);
    expect(note.reads).toEqual(["stream"]);
  });
});
