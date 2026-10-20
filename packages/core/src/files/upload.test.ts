import { describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { HttpError } from "../errors.ts";
import type { ServiceRequest } from "../hooks.ts";
import { fileSamples } from "../testing/file-samples.ts";
import type { EntityModel } from "../model.ts";
import { parseUpload, readMultipart, resolveUploadType, type ParsedUpload } from "./upload.ts";

const BOUNDARY = "sample-boundary";

/** A multipart request built by hand, so each part's headers are exactly the ones given. */
function multipart(parts: { headers: string[]; body: Uint8Array | string }[]): ServiceRequest {
  const chunks: (Uint8Array | string)[] = [];
  for (const part of parts) chunks.push(`--${BOUNDARY}\r\n${part.headers.join("\r\n")}\r\n\r\n`, part.body, "\r\n");
  chunks.push(`--${BOUNDARY}--\r\n`);
  const raw = new Request("http://x/media", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    body: new Blob(chunks),
  });
  return { headers: raw.headers, raw } as unknown as ServiceRequest;
}

const filePart = (name: string, filename: string, body: Uint8Array | string, type?: string) => ({
  headers: [`Content-Disposition: form-data; name="${name}"; filename="${filename}"`, ...(type ? [`Content-Type: ${type}`] : [])],
  body,
});

const file = (bytes: Uint8Array, type: string, name = "upload.bin") => new File([bytes], name, { type });

async function rejection(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    return error as HttpError;
  }
  throw new Error("Expected a rejection");
}

describe("declared types", () => {
  test("come from the part's Content-Type header, not from the file name", async () => {
    const form = await readMultipart(
      multipart([
        filePart("file", "logo.png", "abc", "image/gif"),
        filePart("file", "notes.png", "abc", "text/markdown"),
        filePart("other", "photo.jpg", "abc"),
        { headers: ['Content-Disposition: form-data; name="alt"'], body: "Logo" },
      ]),
    );
    const [first, second] = form.getAll("file") as File[];
    expect([first!.type, first!.name]).toEqual(["image/gif", "logo.png"]);
    expect([second!.type, second!.name]).toEqual(["text/markdown", "notes.png"]);
    expect((form.get("other") as File).type).toBe("");
    expect(form.get("alt")).toBe("Logo");
    expect(await first!.text()).toBe("abc");
  });

  test("a quoted boundary and header names in any case are read", async () => {
    const body = `--b1\r\ncontent-disposition: form-data; name="file"; filename="a.png"\r\ncontent-type: Image/GIF\r\n\r\nabc\r\n--b1--\r\n`;
    const raw = new Request("http://x/", { method: "POST", headers: { "content-type": 'multipart/form-data; boundary="b1"' }, body });
    const form = await readMultipart({ headers: raw.headers, raw } as unknown as ServiceRequest);
    expect((form.get("file") as File).type).toBe("image/gif");
  });
});

describe("resolved types", () => {
  test("a detected format declared as another type fails", async () => {
    const error = await rejection(resolveUploadType(file(fileSamples.png, "image/gif"), "logo"));
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(415);
    expect(error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect(error.message).toBe("File content does not match its type");
    expect(error.details).toEqual([{ field: "logo", message: "Detected image/png, declared image/gif" }]);
  });

  test("the comparison ignores parameters and case", async () => {
    expect((await resolveUploadType(file(fileSamples.pdf, "Application/PDF; version=1.4"), "file")).type).toBe("application/pdf");
  });

  test("a missing or octet-stream declared type takes the detected type", async () => {
    expect((await resolveUploadType(file(fileSamples.png, ""), "file")).type).toBe("image/png");
    expect((await resolveUploadType(file(fileSamples.jpeg, "application/octet-stream"), "file")).type).toBe("image/jpeg");
  });

  test("an unrecognized format keeps its declared type, name and bytes", async () => {
    const resolved = await resolveUploadType(file(fileSamples.csv, "text/csv", "items.csv"), "file");
    expect([resolved.type, resolved.name, await resolved.text()]).toEqual(["text/csv", "items.csv", "name,qty\nbolt,4\n"]);
  });
});

describe("compatible declared types", () => {
  const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  test("a generic ZIP file keeps any declared type, and takes application/zip when none is declared", async () => {
    expect((await resolveUploadType(file(fileSamples.pptx, PPTX), "file")).type).toBe(PPTX);
    expect((await resolveUploadType(file(fileSamples.zip, "application/epub+zip"), "file")).type).toBe("application/epub+zip");
    expect((await resolveUploadType(file(fileSamples.zip, "application/octet-stream"), "file")).type).toBe("application/zip");
  });

  test("DOCX and XLSX must match their declared type", async () => {
    const error = await rejection(resolveUploadType(file(fileSamples.docx, XLSX), "file"));
    expect(error.status).toBe(415);
    expect((await resolveUploadType(file(fileSamples.xlsx, XLSX), "file")).type).toBe(XLSX);
  });

  test("audio types are accepted for MP4 and WebM video, keeping the declared type", async () => {
    expect((await resolveUploadType(file(fileSamples.mp4, "audio/mp4"), "file")).type).toBe("audio/mp4");
    expect((await resolveUploadType(file(fileSamples.webm, "audio/webm"), "file")).type).toBe("audio/webm");
    expect((await resolveUploadType(file(fileSamples.webm, ""), "file")).type).toBe("video/webm");
  });

  test("other audio and video mismatches fail", async () => {
    expect((await rejection(resolveUploadType(file(fileSamples.mp3, "video/mp4"), "file"))).details).toEqual([
      { field: "file", message: "Detected audio/mpeg, declared video/mp4" },
    ]);
    expect((await rejection(resolveUploadType(file(fileSamples.mp4, "audio/webm"), "file"))).status).toBe(415);
    expect((await rejection(resolveUploadType(file(fileSamples.webm, "audio/mp4"), "file"))).status).toBe(415);
  });
});

describe("declared types in one pass", () => {
  test("each file part keeps its own declared type and bytes, also when the body arrives in small chunks", async () => {
    const body = await new Response(
      multipart([
        filePart("files", "a.png", fileSamples.png, "image/png"),
        filePart("files", "b.txt", "plain", "Text/Plain; Charset=UTF-8"),
        filePart("files", "c.bin", ""),
        { headers: ['Content-Disposition: form-data; name="files"'], body: "an id" },
      ]).raw.body,
    ).bytes();
    const raw = new Request("http://x/media", {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (let start = 0; start < body.length; start += 5) controller.enqueue(body.subarray(start, start + 5));
          controller.close();
        },
      }),
    });
    const form = await readMultipart({ headers: raw.headers, raw } as unknown as ServiceRequest);
    const [png, text, empty, id] = form.getAll("files") as [File, File, File, string];
    expect([png.name, png.type, png.size]).toEqual(["a.png", "image/png", fileSamples.png.length]);
    expect(new Uint8Array(await png.arrayBuffer())).toEqual(fileSamples.png);
    expect([text.name, text.type, await text.text()]).toEqual(["b.txt", "text/plain; charset=utf-8", "plain"]);
    expect([empty.name, empty.type, empty.size]).toEqual(["c.bin", "", 0]);
    expect(id).toBe("an id");
  });
});

describe("malformed bodies and limits", () => {
  const send = (body: string | ReadableStream<Uint8Array>, contentType = `multipart/form-data; boundary=${BOUNDARY}`) => {
    const raw = new Request("http://x/media", { method: "POST", headers: { "content-type": contentType }, body });
    return { headers: raw.headers, raw } as unknown as ServiceRequest;
  };
  const head = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\n`;

  test("malformed bodies fail with the form parser's errors", async () => {
    const cases: [string | ReadableStream<Uint8Array>, string, string?][] = [
      ["", "FormData parse error missing final boundary"],
      ["no boundary here", "FormData parse error missing final boundary"],
      [`${head}\r\nabc\r\n`, "FormData parse error missing final boundary"],
      [`${head}abc\r\n--${BOUNDARY}--`, "FormData parse error is missing header end"],
      [`${head}not a header\r\n\r\nabc\r\n--${BOUNDARY}--`, "FormData parse error is missing header colon separator"],
      [`${head}\r\nabc\r\n--${BOUNDARY}--`, "Can't decode form data from body because of incorrect MIME type/boundary", "multipart/form-data"],
    ];
    for (const [body, message, contentType] of cases) {
      const error = await rejection(readMultipart(send(body, contentType)));
      expect([error.name, error.message]).toEqual(["TypeError", message]);
    }
    expect((await rejection(readMultipart(send("", "text/plain")))).status).toBe(415);
  });

  test("an oversized file part fails before the rest of the body is read", async () => {
    const model = { key: "Media", fields: [], file: { base: "file" }, fileLimits: { maxSize: 100 } } as unknown as EntityModel;
    const settings = { storage: {}, files: { maxSize: 1024, accept: ["*/*"] } };
    // A body that never ends: only the first chunk ever arrives.
    const endless = (type: string, bytes: Uint8Array) =>
      send(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([...new TextEncoder().encode(`${head}Content-Type: ${type}\r\n\r\n`), ...bytes]));
          },
        }),
      );
    const big = (sample: Uint8Array) => new Uint8Array([...sample, ...new Uint8Array(200)]);

    const tooLarge = await rejection(parseUpload(endless("image/png", big(fileSamples.png)), model, settings));
    expect([tooLarge.status, tooLarge.message, tooLarge.details]).toEqual([413, "File too large", undefined]);
    // The type mismatch is still reported first, as when the whole body is read.
    const mismatch = await rejection(parseUpload(endless("image/gif", big(fileSamples.png)), model, settings));
    expect([mismatch.status, mismatch.details]).toEqual([415, [{ field: "file", message: "Detected image/png, declared image/gif" }]]);

    // A complete body answers the same, and a file within the limit passes.
    const complete = multipart([filePart("file", "a.png", big(fileSamples.png), "image/png")]);
    expect((await rejection(parseUpload(complete, model, settings))).status).toBe(413);
    const small = await parseUpload(multipart([filePart("file", "a.png", fileSamples.png, "image/png")]), model, settings);
    expect([small.file.type, small.file.size]).toEqual(["image/png", fileSamples.png.length]);
  });
});

describe("bodies read at once or as they arrive", () => {
  const encoder = new TextEncoder();
  const contentType = `multipart/form-data; boundary=${BOUNDARY}`;
  const fileBody = (bytes: Uint8Array | string, type = "image/png", preamble = "") =>
    new Uint8Array(
      Buffer.concat([
        encoder.encode(`${preamble}--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: ${type}\r\n\r\n`),
        typeof bytes === "string" ? encoder.encode(bytes) : bytes,
        encoder.encode(`\r\n--${BOUNDARY}\r\nContent-Disposition: form-data; name="alt"\r\n\r\nLogo\r\n--${BOUNDARY}--\r\n`),
      ]),
    );
  /** A body of exactly `size` bytes, padded with an ignored preamble. */
  const sized = (size: number) => {
    const bare = fileBody("abc");
    return fileBody("abc", "image/png", "p".repeat(size - bare.length));
  };
  const chunked = (bytes: Uint8Array, cut?: Error) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let start = 0; start < bytes.length; start += 1000) controller.enqueue(bytes.subarray(start, start + 1000));
        if (cut) controller.error(cut);
        else controller.close();
      },
    });

  /** A request that records whether its body was read at once (`bytes`) or as a stream. */
  function tracked(body: Uint8Array | ReadableStream<Uint8Array>, contentLength?: number) {
    const headers: Record<string, string> = { "content-type": contentType };
    if (contentLength !== undefined) headers["content-length"] = String(contentLength);
    const raw = new Request("http://x/media", { method: "POST", headers, body });
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

  /** What a parse ends with: the form's entries, or the error's kind, message, status and details. */
  async function outcome(promise: Promise<FormData | { file: Blob; data: unknown }>) {
    try {
      const result = await promise;
      const values = result instanceof FormData ? [...result.entries()] : [["file", result.file] as const, ["data", JSON.stringify(result.data)] as const];
      return await Promise.all(
        values.map(async ([name, value]) =>
          typeof value === "string" ? [name, value] : [name, value.type, value.size, Buffer.from(await value.arrayBuffer()).toString("base64")],
        ),
      );
    } catch (error) {
      const failure = error as HttpError;
      return { error: [failure.name, failure.message, failure.status, failure.details] };
    }
  }

  const model = { key: "Media", fields: [], file: { base: "file" }, fileLimits: { maxSize: 100 } } as unknown as EntityModel;
  const settings = { storage: {}, files: { maxSize: 1024, accept: ["*/*"] } };
  const oversized = new Uint8Array([...fileSamples.png, ...new Uint8Array(200)]);

  test("a body with a Content-Length is read at once, with the same outcome as when it streams", async () => {
    const cases: [Uint8Array, (req: ServiceRequest) => Promise<FormData | ParsedUpload>][] = [
      [fileBody(fileSamples.png), (req) => readMultipart(req)],
      [fileBody(fileSamples.png), (req) => parseUpload(req, model, settings)],
      [fileBody(oversized), (req) => parseUpload(req, model, settings)],
      [fileBody(oversized, "image/gif"), (req) => parseUpload(req, model, settings)],
      [fileBody("abc").subarray(0, 120), (req) => readMultipart(req)],
      [encoder.encode(`--${BOUNDARY}\r\nno colon\r\n\r\nabc\r\n--${BOUNDARY}--`), (req) => readMultipart(req)],
    ];
    for (const [body, parse] of cases) {
      const atOnce = tracked(body, body.length);
      const streamed = tracked(chunked(body));
      const expected = await outcome(parse(streamed.req));
      expect(await outcome(parse(atOnce.req))).toEqual(expected);
      expect([atOnce.reads, streamed.reads]).toEqual([["bytes"], ["stream"]]);
    }
  });

  test("the threshold, missing and wrong Content-Length and truncated bodies", async () => {
    const limit = 1000;
    const threshold = limit + 64 * 1024;
    const largest = sized(threshold);
    const expected = await outcome(readMultipart(tracked(chunked(largest)).req, undefined, limit));
    expect(expected).toEqual([
      ["file", "image/png", 3, "YWJj"],
      ["alt", "Logo"],
    ]);

    // Up to the threshold the body is read at once; past it, and without a Content-Length, it streams.
    const at = tracked(largest, largest.length);
    expect(await outcome(readMultipart(at.req, undefined, limit))).toEqual(expected);
    const past = tracked(sized(threshold + 1), threshold + 1);
    expect(await outcome(readMultipart(past.req, undefined, limit))).toEqual(expected);
    const missing = tracked(largest);
    expect(await outcome(readMultipart(missing.req, undefined, limit))).toEqual(expected);
    const zero = tracked(largest, 0);
    expect(await outcome(readMultipart(zero.req, undefined, limit))).toEqual(expected);
    expect([at.reads, past.reads, missing.reads, zero.reads]).toEqual([["bytes"], ["stream"], ["stream"], ["stream"]]);

    // A Content-Length that does not match the body changes the path, never the outcome.
    const body = fileBody(fileSamples.png);
    const streamed = await outcome(readMultipart(tracked(chunked(body)).req));
    for (const declared of [1, body.length - 1, body.length + 1, 70 * 1024]) {
      const wrong = tracked(body, declared);
      expect(await outcome(readMultipart(wrong.req))).toEqual(streamed);
      expect(wrong.reads).toEqual([declared <= 64 * 1024 ? "bytes" : "stream"]);
    }

    // A body that breaks off fails with its stream's error, and one that ends early with the parser's.
    const cut = new Error("The connection was closed.");
    for (const declared of [body.length, undefined]) {
      expect(await outcome(readMultipart(tracked(chunked(body.subarray(0, 150), cut), declared).req))).toEqual({
        error: ["Error", "The connection was closed.", undefined, undefined],
      });
      expect(await outcome(readMultipart(tracked(chunked(body.subarray(0, 150)), declared).req))).toEqual({
        error: ["TypeError", "FormData parse error missing final boundary", undefined, undefined],
      });
    }
  });

  test("an oversized file past the threshold still fails as soon as its head arrives", async () => {
    // A 2 MB file to a 1 MB limit, as a body that never ends: only its first megabyte and a bit ever arrive.
    const limited = { ...model, fileLimits: { maxSize: 1024 * 1024 } } as EntityModel;
    const start = fileBody(new Uint8Array([...fileSamples.png, ...new Uint8Array(1024 * 1024)]));
    const endless = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(start.subarray(0, start.length - 100));
      },
    });
    const { req, reads } = tracked(endless, 2 * 1024 * 1024);
    expect(await outcome(parseUpload(req, limited, settings))).toEqual({ error: ["HttpError", "File too large", 413, undefined] });
    expect(reads).toEqual(["stream"]);
  });

  test("on a real connection, both paths answer the same to a wrong or a truncated Content-Length", async () => {
    const results: unknown[] = [];
    using server = Bun.serve({
      port: 0,
      async fetch(raw) {
        const maxFileSize = raw.url.endsWith("/at-once") ? 1024 * 1024 : 0;
        results.push(await outcome(readMultipart({ headers: raw.headers, raw } as unknown as ServiceRequest, undefined, maxFileSize)));
        return new Response("done");
      },
    });
    // Bodies over the allowance, so a file limit of 0 makes them stream.
    const body = sized(70 * 1024);
    const send = (path: string, declared: number, bytes: Uint8Array) =>
      new Promise<void>((resolve) => {
        const socket = connect(server.port!, "127.0.0.1", () => {
          socket.write(`POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Type: ${contentType}\r\nContent-Length: ${declared}\r\n\r\n`);
          socket.write(bytes, () => {
            if (declared > bytes.length) setTimeout(() => socket.end(), 50);
          });
        });
        socket.on("data", () => socket.end());
        socket.on("close", () => resolve());
        socket.on("error", () => resolve());
      });
    for (const path of ["/at-once", "/streamed"]) {
      await send(path, body.length, body);
      await send(path, body.length - 10, body);
      await send(path, body.length, body.subarray(0, 40 * 1024));
    }
    while (results.length < 6) await Bun.sleep(10);
    const [whole, short, truncated] = results;
    expect(results.slice(3)).toEqual(results.slice(0, 3));
    expect(whole).toEqual([
      ["file", "image/png", 3, "YWJj"],
      ["alt", "Logo"],
    ]);
    expect(short).toEqual({ error: ["TypeError", "FormData parse error missing final boundary", undefined, undefined] });
    expect(truncated).toEqual({ error: ["AbortError", "The connection was closed.", undefined, undefined] });
  });
});
