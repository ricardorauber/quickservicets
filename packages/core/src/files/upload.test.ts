import { describe, expect, test } from "bun:test";
import { HttpError } from "../errors.ts";
import type { ServiceRequest } from "../hooks.ts";
import { fileSamples } from "../testing/file-samples.ts";
import { readMultipart, resolveUploadType } from "./upload.ts";

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
