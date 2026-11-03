import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "./errors.ts";
import { jsonLogger, safeLog, type Logger } from "./logger.ts";
import { activeSetup } from "./setup-phase.ts";

/** The file an upload check inspects, before it is stored. */
export interface UploadFileView {
  /** The file entity the file is stored as, like `Media`. */
  entity: string;
  /** The path of the file part in an entity upload, like `attachments[1]`; absent for a file entity's own file. */
  field?: string;
  filename: string;
  mimeType: string;
  size: number;
  /** A new readable stream of the content on every call. */
  stream(): ReadableStream<Uint8Array>;
  /** The content as bytes. */
  bytes(): Promise<Uint8Array>;
}

/** Who uploads: the request, its user and tenant; absent outside requests. */
export interface UploadCheckContext {
  req?: unknown;
  user?: unknown;
  tenant?: unknown;
}

/** A check every incoming file passes before it is stored, like an antivirus scan. */
export interface UploadCheck {
  name: string;
  check(file: UploadFileView, ctx: UploadCheckContext): unknown;
}

/** Refuses a file: the upload answers 400 `VALIDATION_ERROR` with the reason. */
export class UploadRejectedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "UploadRejectedError";
    this.reason = reason;
  }
}

/** Tells that a check could not run, like a scanner that does not answer: the upload answers 503. */
export class UploadCheckUnavailableError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "UploadCheckUnavailableError";
    this.reason = reason;
  }
}

const SLOT = Symbol.for("quickservicets.upload.checks");
const state = ((globalThis as unknown as Record<symbol, unknown>)[SLOT] ??= { project: [] as UploadCheck[], features: [] as UploadCheck[], buffer: 8 * 1024 * 1024, logger: jsonLogger as Logger }) as {
  project: UploadCheck[];
  features: UploadCheck[];
  buffer: number;
  logger: Logger;
};

/** The default size up to which a checked file is held in memory. */
export const DEFAULT_CHECK_BUFFER = 8 * 1024 * 1024;

/** Sets the project's checks (`files.checks`) and buffer for a service being set up, removing the features' checks. */
export function configureUploadChecks(settings: { checks: readonly UploadCheck[]; buffer: number; logger?: Logger }): void {
  state.project = [];
  state.features = [];
  for (const entry of settings.checks) register(state.project, entry);
  state.buffer = settings.buffer;
  state.logger = settings.logger ?? jsonLogger;
}

function register(list: UploadCheck[], entry: UploadCheck): void {
  if (typeof entry?.name !== "string" || entry.name === "" || typeof entry.check !== "function") throw new Error("addUploadCheck({ name, check }) needs a name and a check function");
  if ([...state.project, ...state.features].some((existing) => existing.name === entry.name)) throw new Error(`Upload check ${entry.name} is registered twice`);
  list.push(entry);
}

/** Registers a check every upload and `createFile` passes before the file is stored; only during setup. */
export function addUploadCheck(entry: UploadCheck): void {
  if (!activeSetup()) throw new Error("addUploadCheck must be called during setup");
  register(state.features, entry);
}

/** Whether any check is registered, so uploads without checks keep their single-pass path. */
export function hasUploadChecks(): boolean {
  return state.project.length > 0 || state.features.length > 0;
}

/** The view of a file: in memory up to the buffer size, spooled to a temporary file beyond it. */
async function viewOf(file: Blob & { name?: string }, entity: string, field: string | undefined): Promise<{ view: UploadFileView; release(): void }> {
  const base = { entity, ...(field !== undefined ? { field } : {}), filename: file.name ?? "file", mimeType: file.type, size: file.size };
  if (file.size <= state.buffer) {
    return { view: { ...base, stream: () => file.stream() as ReadableStream<Uint8Array>, bytes: async () => new Uint8Array(await file.arrayBuffer()) }, release() {} };
  }
  const dir = mkdtempSync(join(tmpdir(), "quickservicets-upload-check-"));
  const path = join(dir, "content");
  await Bun.write(path, file);
  const spooled = Bun.file(path);
  return {
    view: { ...base, stream: () => spooled.stream() as ReadableStream<Uint8Array>, bytes: async () => new Uint8Array(await spooled.arrayBuffer()) },
    release: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** The temporary folders checked files are spooled to while their checks run, for tests. */
export const spoolPrefix = "quickservicets-upload-check-";

/**
 * Runs every check on a file, the project's first, before it is stored: a rejection is a 400 with the reason, an
 * unavailable check a 503 `SCANNER_UNAVAILABLE` and any other error a 500.
 */
export async function runUploadChecks(file: Blob & { name?: string }, target: { entity: string; field?: string }, ctx: UploadCheckContext = {}): Promise<void> {
  if (!hasUploadChecks()) return;
  const { view, release } = await viewOf(file, target.entity, target.field);
  const path = target.field ?? "file";
  try {
    for (const entry of [...state.project, ...state.features]) {
      try {
        await entry.check(view, ctx);
      } catch (error) {
        if (error instanceof UploadRejectedError) {
          safeLog(state.logger, "info", { timestamp: new Date().toISOString(), message: "upload.rejected", entity: target.entity, field: path, check: entry.name, reason: error.reason, size: file.size });
          throw new HttpError(400, "Invalid body", { code: "VALIDATION_ERROR", details: [{ field: path, message: error.reason }] });
        }
        if (error instanceof UploadCheckUnavailableError) {
          safeLog(state.logger, "warn", { timestamp: new Date().toISOString(), message: "upload.check.unavailable", entity: target.entity, check: entry.name, reason: error.reason });
          throw new HttpError(503, `Upload check ${entry.name} is unavailable`, { code: "SCANNER_UNAVAILABLE", headers: { "retry-after": "30" } });
        }
        safeLog(state.logger, "error", { timestamp: new Date().toISOString(), message: "upload.check.failed", entity: target.entity, check: entry.name, error: { message: (error as Error)?.message ?? String(error) } });
        throw new HttpError(500, "Internal server error");
      }
    }
  } finally {
    release();
  }
}
