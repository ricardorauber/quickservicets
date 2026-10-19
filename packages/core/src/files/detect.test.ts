import { describe, expect, test } from "bun:test";
import { fileSamples, zipSample } from "../testing/file-samples.ts";
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

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("archives", () => {
  test("recognizes ZIP, DOCX and XLSX", async () => {
    expect(await detectFileType(blob(fileSamples.zip))).toBe("application/zip");
    expect(await detectFileType(blob(fileSamples.docx))).toBe(DOCX);
    expect(await detectFileType(blob(fileSamples.xlsx))).toBe(XLSX);
  });

  test("other ZIP-based formats are generic ZIP files", async () => {
    expect(await detectFileType(blob(fileSamples.pptx))).toBe("application/zip");
    const macros = zipSample({ "[Content_Types].xml": '<Override ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/>', "word/document.xml": "" });
    expect(await detectFileType(blob(macros))).toBe("application/zip");
  });

  test("without [Content_Types].xml, the folders tell DOCX and XLSX apart", async () => {
    expect(await detectFileType(blob(zipSample({ "word/": "", "word/document.xml": "<w:document/>" })))).toBe(DOCX);
    expect(await detectFileType(blob(zipSample({ "xl/workbook.xml": "<workbook/>" }, { deflate: true })))).toBe(XLSX);
  });

  test("an empty or unreadable archive is a generic ZIP file", async () => {
    expect(await detectFileType(blob(zipSample({})))).toBe("application/zip");
    expect(await detectFileType(blob(fileSamples.docx.slice(0, 40)))).toBe("application/zip");
  });
});

describe("audio and video", () => {
  test("recognizes MP4, WebM and MP3", async () => {
    expect(await detectFileType(blob(fileSamples.mp4))).toBe("video/mp4");
    expect(await detectFileType(blob(fileSamples.webm))).toBe("video/webm");
    expect(await detectFileType(blob(fileSamples.mp3))).toBe("audio/mpeg");
    expect(await detectFileType(blob(fileSamples.mp3Frame))).toBe("audio/mpeg");
  });

  test("other ISO media and Matroska files are not recognized", async () => {
    const ftyp = (brand: string) => new Blob([new Uint8Array([0, 0, 0, 16]), `ftyp${brand}`, new Uint8Array(4)]);
    expect(await detectFileType(ftyp("heic"))).toBeUndefined();
    expect(await detectFileType(ftyp("qt  "))).toBeUndefined();
    const matroska = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x8f, 0x42, 0x82, 0x88, ...new TextEncoder().encode("matroska")]);
    expect(await detectFileType(blob(matroska))).toBeUndefined();
  });

  test("ADTS audio and truncated headers are not MPEG audio frames", async () => {
    expect(await detectFileType(blob([0xff, 0xf1, 0x50, 0x80, 0, 0x1f, 0xfc]))).toBeUndefined();
    expect(await detectFileType(blob([0xff, 0xfb, 0x90]))).toBeUndefined();
    expect(await detectFileType(blob(fileSamples.mp4.slice(0, 10)))).toBeUndefined();
    expect(await detectFileType(blob(fileSamples.webm.slice(0, 24)))).toBeUndefined();
  });
});
