import { readFileSync, realpathSync } from "node:fs";
import { parseDuration } from "./jobs/job.ts";
import { safeLog, type Logger } from "./logger.ts";
import { loadCertificatePair, logServerCertificate, readCertificates, secureOptionsFor, type CertificateInfo, type ServerTlsConfig } from "./tls.ts";

/** The certificates a reload applies: the server's pair and CAs, and the authorities of client certificates. */
export interface ReloadedTls {
  cert: string;
  key: string;
  ca?: string[];
  passphrase?: string;
  secureOptions: number;
  /** The client certificate authorities, while the service checks client certificates. */
  clientCa?: string[];
  info: CertificateInfo;
}

/** What a reload resolves: whether a file changed, and whether the new certificates now serve new connections. */
export interface TlsReloadResult {
  changed: boolean;
  applied: boolean;
}

/** What a reloader watches and how it applies a change. */
export interface TlsReloaderOptions {
  tls: ServerTlsConfig & { watch?: boolean; reloadInterval?: string };
  /** The `security.mtls.ca` values, file paths or PEM text, while the service checks client certificates. */
  clientCa?: readonly string[];
  logger: Logger;
  /** Makes new connections use the certificates, keeping the open ones; throws when the runtime refuses. */
  apply(next: ReloadedTls): void | Promise<void>;
  /** Called when `apply` failed: the worker drains and exits so the supervisor starts one with the new files. */
  restart?: () => void;
}

const isPem = (value: string) => value.trimStart().startsWith("-----BEGIN");

/** The SHA-256 of a file's content, or `missing` when it cannot be read (a symbolic link being swapped). */
function hashOf(file: string): string {
  try {
    return new Bun.CryptoHasher("sha256").update(readFileSync(realpathSync(file))).digest("hex");
  } catch {
    return "missing";
  }
}

let restartHandler: (() => void) | undefined;

/** Sets what happens when the runtime refuses new certificates: the service drains this worker and exits. */
export function setTlsRestart(handler: (() => void) | undefined): void {
  restartHandler = handler;
}

/** Asks for the restart of this worker after the runtime refused new certificates. */
export function requestTlsRestart(): void {
  restartHandler?.();
}

/** The running reloaders of this process, which `SIGHUP` and `reloadTls()` check at once. */
const reloaders = new Set<TlsReloader>();

/**
 * Watches the files of `server.tls` (and of `security.mtls.ca`) by content hash, at start and every `reloadInterval`,
 * so files replaced in place or through swapped symbolic links (as Kubernetes does) are noticed; a changed set is
 * checked like at startup before it is applied to new connections.
 */
export class TlsReloader {
  private readonly files: string[];
  private hashes = new Map<string, string>();
  /** The hashes of the last set that failed its checks, so it is logged once until the files change again. */
  private failedHashes: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<TlsReloadResult> | undefined;

  constructor(private readonly options: TlsReloaderOptions) {
    const { tls } = options;
    const cas = tls.ca === undefined ? [] : Array.isArray(tls.ca) ? tls.ca : [tls.ca as string];
    this.files = [tls.cert, tls.key, ...cas, ...(options.clientCa ?? [])].filter((value) => typeof value === "string" && !isPem(value));
    for (const file of this.files) this.hashes.set(file, hashOf(file));
  }

  /** Whether the reloader watches anything: `watch` is on and at least one value is a file. */
  get watching(): boolean {
    return this.options.tls.watch !== false && this.files.length > 0;
  }

  /** Starts checking every `reloadInterval`; does nothing while nothing is watched. */
  start(): void {
    if (!this.watching || this.timer) return;
    const intervalMs = parseDuration(this.options.tls.reloadInterval ?? "1m") ?? 60_000;
    this.timer = setInterval(() => void this.check(), intervalMs);
    reloaders.add(this);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    reloaders.delete(this);
  }

  /** Checks the files now, applying a changed and valid set. */
  check(): Promise<TlsReloadResult> {
    this.running ??= this.checkOnce().finally(() => (this.running = undefined));
    return this.running;
  }

  private async checkOnce(): Promise<TlsReloadResult> {
    const current = new Map(this.files.map((file) => [file, hashOf(file)]));
    const changed = this.files.some((file) => current.get(file) !== this.hashes.get(file));
    if (!changed) return { changed: false, applied: false };
    const key = this.files.map((file) => current.get(file)).join(",");
    const { tls, logger } = this.options;
    let next: ReloadedTls;
    try {
      const pair = loadCertificatePair(tls, "server.tls");
      next = {
        cert: pair.cert,
        key: pair.key,
        ...(pair.ca ? { ca: pair.ca } : {}),
        ...(tls.passphrase !== undefined ? { passphrase: tls.passphrase } : {}),
        secureOptions: secureOptionsFor(tls.minVersion ?? "TLSv1.2"),
        ...(this.options.clientCa ? { clientCa: readCertificates(this.options.clientCa, "security.mtls.ca").pems } : {}),
        info: pair.info,
      };
    } catch (error) {
      if (this.failedHashes !== key) {
        this.failedHashes = key;
        safeLog(logger, "error", { timestamp: new Date().toISOString(), message: "tls.reload.failed", reason: (error as Error)?.message ?? String(error) });
      }
      return { changed: true, applied: false };
    }
    try {
      await this.options.apply(next);
    } catch (error) {
      safeLog(logger, "error", { timestamp: new Date().toISOString(), message: "tls.reload.failed", reason: `the runtime refused the new certificates: ${(error as Error)?.message ?? String(error)}`, restart: true });
      this.options.restart?.();
      return { changed: true, applied: false };
    }
    this.hashes = current;
    this.failedHashes = undefined;
    logServerCertificate(logger, next.info, tls, "tls.reloaded");
    return { changed: true, applied: true };
  }
}

/**
 * Checks the certificate files of every running server of this process at once, as `SIGHUP` does; resolves whether
 * a file changed and whether the new certificates were applied. Without watched files it logs `tls.reload.skipped`.
 */
export async function reloadTls(logger?: Logger): Promise<TlsReloadResult> {
  const active = [...reloaders];
  if (active.length === 0) {
    if (logger) safeLog(logger, "info", { timestamp: new Date().toISOString(), message: "tls.reload.skipped", reason: "no certificate file is watched (server.tls.watch is false, or the values are PEM text)" });
    return { changed: false, applied: false };
  }
  const results = await Promise.all(active.map((reloader) => reloader.check()));
  return { changed: results.some((result) => result.changed), applied: results.some((result) => result.applied) };
}
