import { describe, expect, test } from "bun:test";
import { fileSamples } from "../testing/file-samples.ts";
import { detectFileType } from "./detect.ts";

const blob = (bytes: Uint8Array | number[]) => new Blob([new Uint8Array(bytes)]);

describe("detectFileType", () => {
  test.each([
    ["png", "image/png"],
    ["jpeg", "image/jpeg"],
    ["gif", "image/gif"],
    ["webp", "image/webp"],
    ["pdf", "application/pdf"],
  ] as const)("recognizes %s from its first bytes", async (sample, type) => {
    expect(await detectFileType(blob(fileSamples[sample]))).toBe(type);
  });

  test("recognizes both GIF versions", async () => {
    expect(await detectFileType(new Blob(["GIF87a\x01\x00"]))).toBe("image/gif");
  });

  test("does not recognize text or empty files", async () => {
    expect(await detectFileType(blob(fileSamples.csv))).toBeUndefined();
    expect(await detectFileType(blob([]))).toBeUndefined();
  });

  test("does not recognize files shorter than the signature", async () => {
    expect(await detectFileType(blob(fileSamples.png.slice(0, 7)))).toBeUndefined();
    expect(await detectFileType(blob(fileSamples.jpeg.slice(0, 2)))).toBeUndefined();
    expect(await detectFileType(blob(fileSamples.gif.slice(0, 5)))).toBeUndefined();
    expect(await detectFileType(blob(fileSamples.webp.slice(0, 11)))).toBeUndefined();
    expect(await detectFileType(blob(fileSamples.pdf.slice(0, 4)))).toBeUndefined();
  });

  test("a RIFF file that is not WebP is not recognized", async () => {
    expect(await detectFileType(new Blob(["RIFF\x00\x00\x00\x00WAVEfmt "]))).toBeUndefined();
  });
});
