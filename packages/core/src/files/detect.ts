import { inflateRawSync } from "node:zlib";

/** How many leading bytes the signatures need. */
export const HEAD_SIZE = 64;

const ZIP_TYPE = "application/zip";
const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/** Byte patterns at the start of a file; `null` matches any byte. */
const SIGNATURES: { type: string; bytes: (number | null)[] }[] = [
  { type: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { type: "image/gif", bytes: ascii("GIF87a") },
  { type: "image/gif", bytes: ascii("GIF89a") },
  { type: "image/webp", bytes: [...ascii("RIFF"), null, null, null, null, ...ascii("WEBP")] },
  { type: "application/pdf", bytes: ascii("%PDF-") },
  { type: "audio/mpeg", bytes: ascii("ID3") },
];

/**
 * Major brands of the `ftyp` box that mark an MP4 file. Other ISO media files (HEIC, AVIF, QuickTime, 3GP) and the
 * audio-only brands of `.m4a`/`.m4b` files are not recognized, so they keep their declared type.
 */
const MP4_BRANDS = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "iso7", "iso8", "iso9", "mp41", "mp42", "mp71", "avc1", "dash", "M4V ", "M4VH", "M4VP", "f4v ", "MSNV", "NDAS"]);

/** Declared types accepted for a detected type, keeping the declared one. */
const COMPATIBLE: Record<string, (declared: string) => boolean> = {
  // Many formats are ZIP archives; only DOCX and XLSX are told apart, so a plain ZIP takes any declared type.
  [ZIP_TYPE]: () => true,
  "video/mp4": (declared) => declared === "audio/mp4",
  "video/webm": (declared) => declared === "audio/webm",
};

/** Whether a declared type (without parameters, in lower case) may stand for a detected format. */
export function declaredTypeFits(detected: string, declared: string): boolean {
  return COMPATIBLE[detected]?.(declared) ?? false;
}

function startsWith(head: Uint8Array, bytes: (number | null)[], offset = 0): boolean {
  return head.length >= offset + bytes.length && bytes.every((byte, index) => byte === null || head[offset + index] === byte);
}

const text = (bytes: Uint8Array) => String.fromCharCode(...bytes);

/** The `ftyp` box of ISO media, with an MP4 major brand. */
function isMp4(head: Uint8Array): boolean {
  return startsWith(head, ascii("ftyp"), 4) && head.length >= 12 && MP4_BRANDS.has(text(head.subarray(8, 12)));
}

/** An EBML element size: the leading 1 bits of the first byte give its length. */
function readVint(bytes: Uint8Array, offset: number): { value: number; length: number } | undefined {
  const first = bytes[offset];
  if (first === undefined || first === 0) return undefined;
  const length = Math.clz32(first) - 23;
  if (offset + length > bytes.length) return undefined;
  let value = first & (0xff >> length);
  for (let index = 1; index < length; index++) value = value * 256 + bytes[offset + index]!;
  return { value, length };
}

/** An EBML header whose DocType element is `webm`. */
function isWebm(head: Uint8Array): boolean {
  if (!startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return false;
  for (let offset = 4; offset < head.length - 2; offset++) {
    if (head[offset] !== 0x42 || head[offset + 1] !== 0x82) continue;
    const size = readVint(head, offset + 2);
    if (!size) return false;
    const start = offset + 2 + size.length;
    return text(head.subarray(start, start + size.value)) === "webm";
  }
  return false;
}

/** An MPEG audio frame header: the sync bits, then a valid version, layer, bitrate and sample rate. */
function isMpegFrame(head: Uint8Array): boolean {
  const [sync, second = 0, third = 0] = head;
  if (sync !== 0xff || (second & 0xe0) !== 0xe0 || head.length < 4) return false;
  const version = (second >> 3) & 3;
  const layer = (second >> 1) & 3;
  return version !== 1 && layer !== 0 && third >> 4 !== 15 && ((third >> 2) & 3) !== 3;
}

const read = async (file: Blob, start: number, end: number) =>
  // The global Blob type of the project's libraries leaves out `slice`, which every runtime Blob has.
  new Uint8Array(await (file as Blob & { slice(start: number, end: number): Blob }).slice(start, end).arrayBuffer());

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

/** The entries listed in a ZIP file's central directory, or undefined when it cannot be read. */
async function zipEntries(file: Blob): Promise<ZipEntry[] | undefined> {
  const tailStart = Math.max(0, file.size - (22 + 0xffff));
  const tail = await read(file, tailStart, file.size);
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let end = -1;
  for (let offset = tail.length - 22; offset >= 0; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end === -1) return undefined;
  const count = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  const start = view.getUint32(end + 16, true);
  if (start + size > file.size) return undefined;
  const directory = await read(file, start, start + size);
  const entries = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
  const result: ZipEntry[] = [];
  let offset = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > directory.length || entries.getUint32(offset, true) !== 0x02014b50) return undefined;
    const nameLength = entries.getUint16(offset + 28, true);
    const skip = nameLength + entries.getUint16(offset + 30, true) + entries.getUint16(offset + 32, true);
    result.push({
      name: new TextDecoder().decode(directory.subarray(offset + 46, offset + 46 + nameLength)),
      method: entries.getUint16(offset + 10, true),
      compressedSize: entries.getUint32(offset + 20, true),
      localOffset: entries.getUint32(offset + 42, true),
    });
    offset += 46 + skip;
  }
  return result;
}

/** The text of a small stored or deflated entry, or undefined when it cannot be read. */
async function zipEntryText(file: Blob, entry: ZipEntry): Promise<string | undefined> {
  const maxSize = 1024 * 1024;
  if (entry.compressedSize > maxSize || (entry.method !== 0 && entry.method !== 8)) return undefined;
  const header = await read(file, entry.localOffset, entry.localOffset + 30);
  if (header.length < 30) return undefined;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (view.getUint32(0, true) !== 0x04034b50) return undefined;
  const dataStart = entry.localOffset + 30 + view.getUint16(26, true) + view.getUint16(28, true);
  const data = await read(file, dataStart, dataStart + entry.compressedSize);
  try {
    const bytes = entry.method === 0 ? data : inflateRawSync(data, { maxOutputLength: maxSize });
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

/** DOCX or XLSX by the main part named in `[Content_Types].xml` (or, without it, by their folders); any other ZIP is generic. */
async function zipType(file: Blob): Promise<string> {
  const entries = await zipEntries(file);
  if (!entries) return ZIP_TYPE;
  const contentTypes = entries.find((entry) => entry.name === "[Content_Types].xml");
  const declared = contentTypes ? await zipEntryText(file, contentTypes) : undefined;
  if (declared !== undefined) {
    if (declared.includes(`"${DOCX_TYPE}.main+xml"`)) return DOCX_TYPE;
    if (declared.includes(`"${XLSX_TYPE}.main+xml"`)) return XLSX_TYPE;
    return ZIP_TYPE;
  }
  if (entries.some((entry) => entry.name.startsWith("word/"))) return DOCX_TYPE;
  if (entries.some((entry) => entry.name.startsWith("xl/"))) return XLSX_TYPE;
  return ZIP_TYPE;
}

/** Whether a file starts as a ZIP archive, whose exact format needs more than its leading bytes. */
export function isZipHead(head: Uint8Array): boolean {
  return startsWith(head, ascii("PK\x03\x04")) || startsWith(head, ascii("PK\x05\x06"));
}

/** The MIME type of a file recognized from its leading bytes alone (not a ZIP archive), or undefined. */
export function detectHeadType(head: Uint8Array): string | undefined {
  const signature = SIGNATURES.find((candidate) => startsWith(head, candidate.bytes));
  if (signature) return signature.type;
  if (isMp4(head)) return "video/mp4";
  if (isWebm(head)) return "video/webm";
  if (isMpegFrame(head)) return "audio/mpeg";
  return undefined;
}

/** The MIME type of a file recognized from its content, or undefined when the format is not one the server knows. */
export async function detectFileType(file: Blob): Promise<string | undefined> {
  const head = await read(file, 0, HEAD_SIZE);
  return isZipHead(head) ? zipType(file) : detectHeadType(head);
}
