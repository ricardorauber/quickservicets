import { describe, expect, test } from "bun:test";
import { boundaryOf, MultipartReader } from "./multipart.ts";

/** Reads a body in chunks of the given size, as a body arriving over the network would. */
function read(body: string | Uint8Array, boundary: string, chunkSize = Number.POSITIVE_INFINITY) {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const reader = new MultipartReader(boundary);
  for (let start = 0; start < bytes.length; start += Math.min(chunkSize, bytes.length)) reader.push(bytes.subarray(start, start + chunkSize));
  const { body: whole, parts } = reader.end();
  return parts.map((part) => ({
    name: part.name,
    filename: part.filename,
    type: part.type,
    value: whole.toString("utf8", part.start, part.end),
  }));
}

describe("multipart parsing", () => {
  test("reads quoted boundaries, preambles, epilogues, extended file names, empty files and plain fields in any chunking", () => {
    expect(boundaryOf('multipart/form-data; boundary="a b"; charset=utf-8')).toBe("a b");
    expect(boundaryOf("multipart/form-data; boundary=xyz")).toBe("xyz");
    expect(boundaryOf("multipart/form-data")).toBeUndefined();

    const body = [
      "This preamble is ignored.\r\n",
      "--a b\r\n",
      'Content-Disposition: form-data; name="title"\r\n\r\n',
      "Line one\r\nLine two, ação\r\n",
      "--a b  \r\n",
      "Content-Disposition: form-data; name=\"doc\"; filename=\"plain.txt\"; filename*=UTF-8''r%C3%A9sum%C3%A9.txt\r\n",
      "Content-Type: text/plain\r\n\r\n",
      "--a not the boundary\r\n",
      "--a b\r\n",
      "Content-Disposition: form-data; name=\"latin\"; filename*=iso-8859-1'en'caf%E9.txt\r\n\r\n",
      "x\r\n",
      "--a b\r\n",
      'Content-Disposition: form-data; name="empty"; filename=""\r\n',
      "Content-Type: application/octet-stream\r\n\r\n",
      "\r\n",
      "--a b\r\n",
      'Content-Disposition: form-data; name="semi;colon"; filename="a;b.txt"\r\n\r\n',
      "\r\n",
      "--a b\r\n",
      "Content-Disposition: form-data\r\n\r\n",
      "a part without a name is skipped\r\n",
      "--a b--\r\n",
      "This epilogue is ignored, even with --a b in it.",
    ].join("");
    const expected = [
      { name: "title", filename: undefined, type: undefined, value: "Line one\r\nLine two, ação" },
      { name: "doc", filename: "résumé.txt", type: "text/plain", value: "--a not the boundary" },
      { name: "latin", filename: "café.txt", type: undefined, value: "x" },
      { name: "empty", filename: "", type: "application/octet-stream", value: "" },
      { name: "semi;colon", filename: "a;b.txt", type: undefined, value: "" },
    ];
    expect(read(body, "a b")).toEqual(expected);
    for (const chunkSize of [1, 2, 3, 7, 64]) expect(read(body, "a b", chunkSize)).toEqual(expected);
  });
});
