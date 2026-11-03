import { currentDatabaseScope, scopedAdapter } from "./database-scope.ts";
import type { DatabaseAdapter } from "./adapter.ts";
import { HttpError } from "./errors.ts";
import { fileUrlOf, type FileAccessSettings } from "./files/access.ts";
import { sanitizeFilename } from "./files/limits.ts";
import { assertFileAllowed, maxFileSize, resolveUploadType, storeFile, type UploadSettings } from "./files/upload.ts";
import { jsonLogger, safeLog, type Logger } from "./logger.ts";
import type { StoredRecord } from "./adapter.ts";
import type { EntityModel } from "./model.ts";
import { repositoryLookup, type RepositoryRegistry } from "./repository.ts";
import { inTransaction, onRollback } from "./transactions.ts";
import { parseDuration } from "./jobs/job.ts";

/**
 * The file entities of the project, by name; the build fills it in `.generated/types.ts` with `File`, `Media` and the
 * project's file entities that the model has, so `createFile("Post", …)` is a type error.
 */
export interface FileEntityNames {}

/** The name of a file entity of the project. */
export type FileEntityName = [keyof FileEntityNames] extends [never] ? string : Extract<keyof FileEntityNames, string>;

/** The content `createFile` stores. */
export type FileBody = Uint8Array | ArrayBuffer | Blob | string | ReadableStream<Uint8Array>;

/** What `createFile` takes. */
export interface CreateFileInput {
  body: FileBody;
  filename: string;
  /** The declared type; the detected one by default, else `application/octet-stream`. */
  mimeType?: string;
  /** The entity's own fields, validated like a JSON create. */
  fields?: Record<string, unknown>;
  /** A configured storage name, over the entity's. */
  storage?: string;
}

/** A stored file opened for reading. */
export interface OpenedFile {
  stream: ReadableStream<Uint8Array>;
  size: number;
  mimeType: string;
  filename: string;
  record: StoredRecord;
}

/** What `createFile`, `openFile` and `fileUrl` need from the running service. */
export interface FileRecordSettings {
  models: readonly EntityModel[];
  /** The service's database, whose stored rows keep the storage keys reads leave out. */
  adapter: DatabaseAdapter;
  uploads: UploadSettings;
  access: FileAccessSettings;
  logger?: Logger;
  /** Runs the upload checks on a file before it is stored (the core's `addUploadCheck`). */
  check?: (file: File, model: EntityModel) => Promise<void>;
}

const SLOT = Symbol.for("quickservicets.files.records");
const slot = globalThis as unknown as { [SLOT]?: FileRecordSettings };

/** Sets (or removes) the settings of the running service; `createApp` sets them. */
export function configureFileRecords(settings: FileRecordSettings | undefined): void {
  slot[SLOT] = settings;
}

function settingsOf(): FileRecordSettings {
  const settings = slot[SLOT];
  if (!settings) throw new Error("Files are not available: the service has not started yet");
  return settings;
}

function fileModel(settings: FileRecordSettings, name: string): EntityModel {
  const model = settings.models.find((candidate) => candidate.file && (candidate.entityName === name || candidate.key === name));
  if (!model) throw new Error(`${name} is not a file entity of this project`);
  return model;
}

/** The file entity of a record and its stored row (with the storage key reads leave out), found by its id. */
async function storedOf(settings: FileRecordSettings, record: StoredRecord, entity?: string): Promise<{ model: EntityModel; row: StoredRecord | null }> {
  const candidates = entity !== undefined ? [fileModel(settings, entity)] : settings.models.filter((model) => model.file);
  const adapter = scopedAdapter(settings.adapter);
  for (const model of candidates) {
    const row = await adapter.findById(model, String(record.id));
    if (row) return { model, row };
  }
  if (entity !== undefined) return { model: candidates[0]!, row: null };
  throw new Error("The record is not a record of a file entity");
}

/** Reads a stream into a Blob, stopping as soon as it passes `limit` bytes without keeping the rest. */
async function streamed(stream: ReadableStream<Uint8Array>, limit: number, tooLarge: () => Error): Promise<Blob> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return new Blob(chunks as unknown as ConstructorParameters<typeof Blob>[0]);
}

const repositoriesNow = () => currentDatabaseScope().repos as unknown as RepositoryRegistry;

/**
 * Creates a record of a file entity from bytes code produced, with the rules of an HTTP upload: the size limit, type
 * detection, `@accept` and the Media rule, the upload checks and a sanitized filename. The object is stored first and
 * deleted again when the insert fails, or when the surrounding transaction rolls back.
 */
export async function createFile(entity: FileEntityName, input: CreateFileInput): Promise<StoredRecord> {
  const settings = settingsOf();
  let model = fileModel(settings, entity);
  if (input.storage !== undefined) {
    if (!(input.storage in settings.uploads.storage)) throw new Error(`Storage "${input.storage}" is not configured`);
    model = { ...model, storageName: input.storage };
  }
  const limit = maxFileSize(model, settings.uploads);
  const tooLarge = () => new HttpError(413, "File too large", { code: "PAYLOAD_TOO_LARGE" });
  const body = input.body;
  const blob =
    body instanceof ReadableStream ? await streamed(body, limit, tooLarge) : body instanceof Blob ? body : new Blob([typeof body === "string" ? body : body instanceof ArrayBuffer ? new Uint8Array(body) : (body as Uint8Array)] as unknown as ConstructorParameters<typeof Blob>[0]);
  if (blob.size > limit) throw tooLarge();
  const filename = sanitizeFilename(input.filename || "file");
  let file = await resolveUploadType(new File([blob], filename, { type: input.mimeType ?? "" }), "file");
  if (file.type === "") file = new File([file], filename, { type: "application/octet-stream" });
  assertFileAllowed(model, file, settings.uploads, "file");
  await settings.check?.(file, model);
  const id = Bun.randomUUIDv7();
  const stored = await storeFile(model, id, file, settings.uploads);
  let created: StoredRecord;
  try {
    created = (await repositoryLookup(model)(repositoriesNow()).createWith(id, stored.managed, input.fields ?? {})) as StoredRecord;
  } catch (error) {
    await stored.discard();
    throw error;
  }
  if (inTransaction()) onRollback(() => stored.discard());
  safeLog(settings.logger ?? jsonLogger, "info", { timestamp: new Date().toISOString(), message: "files.stored", entity: model.entityName, id, size: file.size, mimeType: file.type });
  return created;
}

/** Opens a stored file: a file record, or `{ entity, id }`; throws 404 `<Entity> not found` without the record or its object. */
export async function openFile(target: StoredRecord | { entity: FileEntityName; id: string }): Promise<OpenedFile> {
  const settings = settingsOf();
  const named = "entity" in target && typeof target.entity === "string" ? target.entity : undefined;
  const { model, row } = await storedOf(settings, target as StoredRecord, named);
  const notFound = () => new HttpError(404, `${model.entityName} not found`);
  if (!row) throw notFound();
  const record = row;
  const storage = settings.uploads.storage[String(record.storage ?? model.storageName ?? "default")];
  const stream = storage ? await storage.get(String(record.storageKey)) : null;
  if (!stream) throw notFound();
  const { storageKey: _key, ...visible } = record;
  return { stream, size: Number(record.size), mimeType: String(record.mimeType), filename: String(record.filename), record: visible as StoredRecord };
}

/**
 * The URL of a stored file in its entity's access mode: the storage's public URL (`direct`), the proxy route (`proxy`),
 * or a signed URL valid for `expiresIn` (`signed`, default `files.signedUrlTtl`); absolute with `server.publicUrl`.
 */
export async function fileUrl(record: StoredRecord, options: { expiresIn?: string } = {}): Promise<string> {
  const settings = settingsOf();
  const { model, row } = await storedOf(settings, record);
  if (!row) throw new HttpError(404, `${model.entityName} not found`);
  record = row;
  if (options.expiresIn === undefined) return fileUrlOf(model, record, settings.access);
  const ms = parseDuration(options.expiresIn);
  if (ms === undefined) throw new Error(`Invalid expiresIn ${options.expiresIn}: expected a duration like 15m`);
  const ttl = Math.max(1, Math.ceil(ms / 1000));
  const timed = model.fileAccess ? { ...model, fileAccess: { ...model.fileAccess, ttl } } : model;
  return fileUrlOf(timed, record, { ...settings.access, files: { ...settings.access.files, signedUrlTtl: ttl } });
}

/** The functions `ctx.files` of jobs and queue consumers carries. */
export interface FileRecordFunctions {
  createFile: typeof createFile;
  openFile: typeof openFile;
  fileUrl: typeof fileUrl;
}

/** The three functions, as `ctx.files` of jobs and queue consumers carries them. */
export const fileRecords: FileRecordFunctions = { createFile, openFile, fileUrl };

/** The storages with the three functions, as `ctx.files` of jobs. */
export function filesContext<S extends object>(storages: S): S & FileRecordFunctions {
  return Object.assign(Object.create(null) as object, storages, fileRecords) as S & FileRecordFunctions;
}

