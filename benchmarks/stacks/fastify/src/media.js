// Media uploads: reads the multipart parts with @fastify/multipart, checks them in the contract's order, writes the
// file under UPLOAD_DIR, then inserts the row.
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { v7 as uuidv7 } from "uuid";
import { HttpError, invalidBody } from "./errors.js";

export const MAX_FILE_SIZE = 1024 * 1024;
const ACCEPTED = new Set(["image/png", "image/jpeg"]);
const READ_ONLY = new Set(["id", "createdAt", "updatedAt", "filename", "mimeType", "size", "storage", "url"]);

const ascii = (text) => [...text].map((char) => char.charCodeAt(0));
/** Byte patterns at the start of a file; `null` matches any byte. */
const SIGNATURES = [
  { type: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { type: "image/gif", bytes: ascii("GIF87a") },
  { type: "image/gif", bytes: ascii("GIF89a") },
  { type: "image/webp", bytes: [...ascii("RIFF"), null, null, null, null, ...ascii("WEBP")] },
  { type: "application/pdf", bytes: ascii("%PDF-") },
  { type: "audio/mpeg", bytes: ascii("ID3") },
];

/** The type the content shows (magic bytes), or undefined when the format is not recognized. */
export function detectType(buffer) {
  for (const { type, bytes } of SIGNATURES) {
    if (buffer.length >= bytes.length && bytes.every((byte, index) => byte === null || buffer[index] === byte)) return type;
  }
  return undefined;
}

/** Base name without path segments or control characters, at most 255 characters. */
export function sanitizeFilename(name) {
  const base = name.split(/[\\/]/).pop() ?? "";
  return base.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255);
}

function extensionOf(filename) {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot).toLowerCase() : "";
}

export function mediaRecord(row) {
  return { ...row, storage: "default", url: `/media/${row.id}/file` };
}

/** Reads every part: the first `file` part (buffered, at most MAX_FILE_SIZE bytes kept) and the other part names. */
async function readParts(request) {
  let file;
  let filePartSeen = false;
  const others = [];
  for await (const part of request.parts()) {
    if (part.fieldname === "file" && !filePartSeen) {
      filePartSeen = true;
      if (part.type === "file") {
        const buffer = await part.toBuffer();
        file = { buffer, truncated: part.file.truncated, filename: part.filename ?? "file", declared: part.mimetype };
      }
      continue;
    }
    if (part.type === "file") part.file.resume();
    if (part.fieldname !== "file" && !others.includes(part.fieldname)) others.push(part.fieldname);
  }
  return { file, others };
}

export async function createMedia(request, pool, uploadDir) {
  if (!request.isMultipart()) throw new HttpError(415, "Must be multipart/form-data");
  const { file, others } = await readParts(request);
  if (!file) throw invalidBody([{ field: "file", message: "Is required" }]);

  const detected = detectType(file.buffer);
  const declared = (file.declared ?? "").split(";")[0].trim().toLowerCase();
  let mimeType = declared;
  if (detected !== undefined) {
    if (declared === "" || declared === "application/octet-stream" || declared === detected) mimeType = detected;
    else {
      throw new HttpError(415, "File content does not match its type", [{ field: "file", message: `Detected ${detected}, declared ${declared}` }]);
    }
  }
  if (file.truncated) throw new HttpError(413, "File too large");
  if (!ACCEPTED.has(mimeType)) throw invalidBody([{ field: "file", message: "File type not allowed" }]);
  if (others.length > 0) {
    throw invalidBody(others.map((name) => ({ field: name, message: READ_ONLY.has(name) ? "Field is read-only" : "Unknown field" })));
  }

  const id = uuidv7();
  const filename = sanitizeFilename(file.filename);
  const storageKey = `media/${id}/${uuidv7()}${extensionOf(filename)}`;
  const target = path.join(uploadDir, storageKey);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, file.buffer);
  const now = new Date();
  const size = file.buffer.length;
  try {
    await pool.query({
      name: "media_insert",
      text: `INSERT INTO media (id, created_at, updated_at, filename, mime_type, size, storage, storage_key) VALUES ($1, $2, $2, $3, $4, $5, 'default', $6)`,
      values: [id, now, filename, mimeType, size, storageKey],
    });
  } catch (error) {
    await unlink(target).catch(() => {});
    throw error;
  }
  return mediaRecord({ id, createdAt: now, updatedAt: now, filename, mimeType, size });
}
