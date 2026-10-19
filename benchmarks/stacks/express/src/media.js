import { Router } from "express";
import busboy from "busboy";
import { mkdir, open, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { v7 as uuidv7 } from "uuid";
import { config } from "./config.js";
import { rows } from "./db.js";
import { HttpError, invalidBody, notFound } from "./errors.js";

const MAX_FILE_SIZE = 1024 * 1024;
const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg"]);
const READ_ONLY = new Set(["id", "createdAt", "updatedAt", "filename", "mimeType", "size", "storage", "url"]);
const MEDIA_COLUMNS = `"id", "created_at", "updated_at", "filename", "mime_type", "size", "storage", "storage_key"`;

/** The format of the content from its magic bytes, or undefined. */
function detectType(bytes) {
  const starts = (signature, at = 0) => bytes.length >= at + signature.length && signature.every((byte, i) => bytes[at + i] === byte);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || starts([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return "image/gif";
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  return undefined;
}

/** The base name of a client file name, without control characters, at most 255 characters. */
const cleanFilename = (name) =>
  (name ?? "").split(/[/\\]/).pop().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255);

/** Reads the whole multipart body: the first file part named `file` (up to the size limit) and the other part names. */
function readMultipart(req) {
  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = busboy({
        headers: req.headers,
        defParamCharset: "utf8",
        // busboy flags a file as truncated once it reaches fileSize, so allow one byte more to accept exactly 1 MiB.
        limits: { fileSize: MAX_FILE_SIZE + 1, files: 10, fields: 100, parts: 110 },
      });
    } catch {
      return reject(new HttpError(415, "Must be multipart/form-data"));
    }
    let file;
    const otherParts = [];
    parser.on("file", (name, stream, info) => {
      if (name !== "file" || file) {
        if (name !== "file") otherParts.push(name);
        stream.resume();
        return;
      }
      const current = { filename: info.filename, declared: info.mimeType.toLowerCase(), chunks: [], size: 0, truncated: false };
      file = current;
      stream.on("data", (chunk) => {
        current.chunks.push(chunk);
        current.size += chunk.length;
      });
      stream.on("limit", () => (current.truncated = true));
    });
    parser.on("field", (name) => {
      if (name !== "file") otherParts.push(name);
    });
    parser.on("error", () => reject(new HttpError(400, "Invalid multipart body")));
    parser.on("close", () => resolve({ file, otherParts }));
    req.pipe(parser);
  });
}

const presentMedia = (row) => ({
  id: row.id,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  filename: row.filename,
  mimeType: row.mime_type,
  size: row.size,
  storage: row.storage,
  url: `/media/${row.id}/file`,
});

export const media = Router();

media.post("/", async (req, res) => {
  if (!req.is("multipart/form-data")) throw new HttpError(415, "Must be multipart/form-data");
  const { file, otherParts } = await readMultipart(req);
  if (!file) throw invalidBody([{ field: "file", message: "Is required" }]);

  const content = Buffer.concat(file.chunks, file.size);
  const detected = detectType(content);
  const declared = file.declared;
  if (detected && declared !== detected && declared !== "application/octet-stream") {
    throw new HttpError(415, "File content does not match its type", [{ field: "file", message: `Detected ${detected}, declared ${declared}` }]);
  }
  const mimeType = detected ?? declared;
  if (file.truncated) throw new HttpError(413, "File too large");
  if (!ACCEPTED_TYPES.has(mimeType)) throw invalidBody([{ field: "file", message: "File type not allowed" }]);
  if (otherParts.length > 0) {
    throw invalidBody(otherParts.map((name) => ({ field: name, message: READ_ONLY.has(name) ? "Field is read-only" : "Unknown field" })));
  }

  const id = uuidv7();
  const filename = cleanFilename(file.filename);
  const storageKey = `media/${id}/${uuidv7()}${extname(filename).toLowerCase()}`;
  const path = join(config.uploadDir, storageKey);
  await mkdir(join(config.uploadDir, "media", id), { recursive: true });
  await writeFile(path, content);
  const now = new Date();
  try {
    await rows(`INSERT INTO "media" (${MEDIA_COLUMNS}) VALUES ($1, $2, $2, $3, $4, $5, 'default', $6)`, [id, now, filename, mimeType, content.length, storageKey], "media_insert");
  } catch (err) {
    await unlink(path).catch(() => {});
    throw err;
  }
  res.status(201).json(presentMedia({ id, created_at: now, updated_at: now, filename, mime_type: mimeType, size: content.length, storage: "default" }));
});

const MEDIA_BY_ID = `SELECT ${MEDIA_COLUMNS} FROM "media" WHERE "id" = $1`;

media.get("/:id", async (req, res) => {
  const [row] = await rows(MEDIA_BY_ID, [req.params.id], "media_by_id");
  if (!row) throw notFound("Media");
  res.json(presentMedia(row));
});

/** `inline; filename="..."` without quotes, backslashes and control characters (plus an RFC 5987 form for non-ASCII). */
function contentDisposition(filename) {
  const safe = filename.replace(/["\\\u0000-\u001f\u007f]/g, "");
  if (/^[\x20-\x7e]*$/.test(safe)) return `inline; filename="${safe}"`;
  return `inline; filename="${safe.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

media.get("/:id/file", async (req, res) => {
  const [row] = await rows(MEDIA_BY_ID, [req.params.id], "media_by_id");
  if (!row) throw notFound("Media");
  let handle;
  try {
    handle = await open(join(config.uploadDir, row.storage_key), "r");
  } catch (err) {
    if (err.code === "ENOENT") throw notFound("Media");
    throw err;
  }
  res.set({ "Content-Type": row.mime_type, "Content-Length": String(row.size), "Content-Disposition": contentDisposition(row.filename) });
  await pipeline(handle.createReadStream(), res);
});
